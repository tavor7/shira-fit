-- Fix: recurring-series horizon generation fails with a duplicate-key error
-- (training_sessions_series_date_uidx) when a session that is already tagged with a
-- series_id for a given date has a different coach_id/start_time than the series'
-- CURRENT template -- the classic case being an intentionally detached ("this occurrence
-- only") session whose coach or time was changed. series_detached rows deliberately keep
-- their series_id (see 20261001150000_session_series_occurrence_identity_stage1.sql); they
-- are not legacy noise to clean up.
--
-- Root cause: _generate_series_occurrence_claim's "physical pre-existence short-circuit"
-- only matched on (coach_id, start_time, session_date) using the series' CURRENT template
-- values. A detached row for the same series+date, filed under a different coach/time,
-- was invisible to that check, so the function tried to insert a second
-- training_sessions row for the same (series_id, session_date) -- which is exactly what
-- training_sessions_series_date_uidx (unique on series_id, session_date where series_id is
-- not null) exists to prevent. That unique-violation's constraint name was not among the
-- two the exception handler recognized, so it propagated, aborted the per-series while-loop
-- (the PL/pgSQL EXCEPTION block is a savepoint around the whole loop, not a single
-- iteration), and was logged as a genuine series_horizon_generation_failed -- which also
-- silently stopped that series from reaching any later, otherwise-unrelated date in the
-- same horizon window.
--
-- Fix, both defense layers:
--   1) Recognize existing occupancy by (series_id, session_date) -- not just by the current
--      physical template slot -- before ever attempting the insert. This is a read-check
--      only; no existing row is touched, so a detached session continues to occupy its
--      original series date exactly as before.
--   2) Add the missing exception branch for training_sessions_series_date_uidx, symmetric
--      with the two it already had, so a race that slips past the pre-check (a concurrent
--      claim/detach between the check and the insert) is verified against the actual
--      conflicting row and classified -- never blindly swallowed, and never misclassified
--      as a different kind of conflict. An unmatched conflicting row (the constraint fired
--      but no row with this series_id+date exists) re-raises: that would be a genuinely
--      unexpected condition, not this bug class.
--
-- No existing training_sessions, session_series, session_series_occurrences, registration,
-- attendance, coach-assignment, or payment row is modified by this migration. It only
-- redefines one function.
create or replace function public._generate_series_occurrence_claim(
  p_series_id uuid,
  p_occurrence_date date
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.session_series%rowtype;
  v_claim_id uuid;
  v_session_id uuid;
  v_constraint text;
  v_owner_series_id uuid;
  v_conflicting record;
begin
  select * into s from public.session_series where id = p_series_id;
  if not found then
    return 'series_not_found';
  end if;

  -- Physical pre-existence short-circuit: a session already sits in this series' CURRENT
  -- template slot (routine case for any date generated before Stage 1 and never edited/backfilled
  -- -- there is no ledger row for it, by design, since historical rows are never touched). Treat
  -- it as already handled and do nothing -- no ledger write, no training_sessions write, no event
  -- log. This is what keeps horizon maintenance idempotent and quiet for all pre-existing
  -- production state without ever backfilling (i.e. without ever UPDATEing) an existing row.
  --
  -- Series-identity short-circuit (this fix): a session already carries THIS series' id for
  -- THIS date, regardless of its own coach_id/start_time -- the case a detached ("this
  -- occurrence only") session with an edited coach or time produces. Checking series_id
  -- directly is what training_sessions_series_date_uidx itself enforces, so this check and
  -- that constraint agree by construction.
  if exists (
    select 1 from public.training_sessions t
    where t.session_date = p_occurrence_date
      and (
        (t.coach_id = s.coach_id and t.start_time = s.start_time)
        or t.series_id = p_series_id
      )
  ) then
    return 'already_handled';
  end if;

  begin
    insert into public.session_series_occurrences (
      series_id, template_occurrence_date, template_coach_id, template_start_time, state
    )
    values (p_series_id, p_occurrence_date, s.coach_id, s.start_time, 'claimed')
    on conflict (series_id, template_occurrence_date) do nothing
    returning id into v_claim_id;

    if v_claim_id is null then
      -- Named conflict target fired: this exact series already handled this exact date.
      -- A cross-series conflict raises an exception instead (caught below), never reaches here.
      return 'already_handled';
    end if;

    insert into public.training_sessions (
      session_date, start_time, coach_id, max_participants,
      is_open_for_registration, is_hidden, is_kickbox, custom_slot_price_ils,
      duration_minutes, series_id, series_detached, series_occurrence_id
    )
    values (
      p_occurrence_date, s.start_time, s.coach_id, s.max_participants,
      s.is_open_for_registration, s.is_hidden, s.is_kickbox, s.custom_slot_price_ils,
      s.duration_minutes, p_series_id, false, v_claim_id
    )
    returning id into v_session_id;

    update public.session_series_occurrences
    set state = 'generated', training_session_id = v_session_id
    where id = v_claim_id;

    if s.roster_policy = 'copy_on_generate'::public.session_series_roster_policy then
      declare
        v_prev_session uuid;
      begin
        select o.training_session_id into v_prev_session
        from public.session_series_occurrences o
        where o.series_id = p_series_id
          and o.state = 'generated'
          and o.template_occurrence_date < p_occurrence_date
        order by o.template_occurrence_date desc
        limit 1;
        if v_prev_session is not null then
          perform public._copy_session_roster(v_prev_session, v_session_id);
        end if;
      end;
    end if;

    return 'created';

  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;

    if v_constraint = 'session_series_occurrences_logical_slot_uidx' then
      select o.series_id into v_owner_series_id
      from public.session_series_occurrences o
      where o.template_coach_id = s.coach_id
        and o.template_start_time = s.start_time
        and o.template_occurrence_date = p_occurrence_date;

      perform public._insert_activity_event(
        null, 'series_logical_conflict', 'session_series', p_series_id::text,
        jsonb_build_object(
          'template_occurrence_date', p_occurrence_date,
          'template_coach_id', s.coach_id,
          'template_start_time', s.start_time,
          'owning_series_id', v_owner_series_id
        )
      );
      return 'series_logical_conflict';

    elsif v_constraint = 'training_sessions_coach_slot_uidx' then
      select id, coach_id, session_date, start_time into v_conflicting
      from public.training_sessions
      where coach_id = s.coach_id and session_date = p_occurrence_date and start_time = s.start_time
      limit 1;

      perform public._insert_activity_event(
        null, 'series_slot_conflict', 'session_series', p_series_id::text,
        jsonb_build_object(
          'template_occurrence_date', p_occurrence_date,
          'template_coach_id', s.coach_id,
          'template_start_time', s.start_time,
          'conflicting_training_session_id', v_conflicting.id
        )
      );
      return 'series_slot_conflict';

    elsif v_constraint = 'training_sessions_series_date_uidx' then
      -- Race: a concurrent claim (or detach) for this series+date landed between the
      -- pre-check above and this insert. Verify the actual conflicting row before
      -- classifying -- never assume the constraint name alone proves the harmless case.
      select id, coach_id, session_date, start_time, series_detached into v_conflicting
      from public.training_sessions
      where series_id = p_series_id and session_date = p_occurrence_date
      limit 1;

      if v_conflicting.id is null then
        -- The constraint fired but no row actually matches (series_id, p_occurrence_date)
        -- any more -- not the condition this branch exists for. Do not misclassify.
        raise;
      end if;

      perform public._insert_activity_event(
        null, 'series_date_already_occupied', 'session_series', p_series_id::text,
        jsonb_build_object(
          'template_occurrence_date', p_occurrence_date,
          'template_coach_id', s.coach_id,
          'template_start_time', s.start_time,
          'conflicting_training_session_id', v_conflicting.id,
          'conflicting_coach_id', v_conflicting.coach_id,
          'conflicting_start_time', v_conflicting.start_time,
          'conflicting_series_detached', v_conflicting.series_detached
        )
      );
      return 'series_date_already_occupied';

    else
      -- Unknown/unexpected unique violation: do not misclassify, propagate to the caller's
      -- existing per-series exception handler.
      raise;
    end if;
  end;
end;
$$;

comment on function public._generate_series_occurrence_claim(uuid, date) is
  'Atomic claim+materialize primitive for one logical series occurrence. Returns one of:
   created, already_handled, series_logical_conflict, series_slot_conflict,
   series_date_already_occupied, series_not_found. Never leaves a session_series_occurrences
   row for a failed materialization attempt.';
