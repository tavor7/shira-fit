-- Fix: roster copying for 'copy_on_generate' series finds no source occurrence after the
-- occurrence-ledger migration, so the next occurrence is created with an EMPTY roster.
--
-- Root cause: before 20261001150000 the generator copied from the latest earlier non-detached session
-- of the series (training_sessions, by session_date). That migration replaced the lookup with
--     select o.training_session_id from session_series_occurrences o
--     where o.series_id = ... and o.state = 'generated' and o.template_occurrence_date < ...
-- i.e. ledger rows only. The ledger was deliberately NOT backfilled, so a series that predates it has
-- no ledger rows at all: for its first ledger-era occurrence the lookup returns NULL,
-- _copy_session_roster is never called and the occurrence is created empty (production example: the
-- capacity-4 series' 2026-11-08 occurrence, with 7 older sessions and no ledger row). Every later
-- occurrence then copies from that empty one, so the roster is lost permanently. The lookup also
-- ignored state 'edited', so an edited occurrence could not carry its roster forward either. This
-- affects every generation path (manager client and cron) because they share the generator.
--
-- Fix (lookup only): new internal helper _series_roster_source_session(series, date) returns the
-- source session of the latest earlier LOGICAL occurrence of the series:
--   * ledger candidates (primary): rows of this series in state 'generated' or 'edited' (both have a
--     session by the table's check constraint) whose template_occurrence_date is earlier than the
--     target, and whose session still belongs to this series, is not detached and is itself dated
--     earlier than the target. Keyed by template_occurrence_date (the logical identity).
--   * legacy fallback: sessions of this series with no ledger link (series_occurrence_id is null,
--     i.e. generated before the ledger and never edited since), not detached, dated earlier than the
--     target. Keyed by session_date, which is their logical date.
--   The latest key wins; the ledger wins a tie. Ledger states 'deleted' (tombstone, no session),
--   'claimed' (transient, same-transaction only, no session) and 'skipped' (allowed by the table check
--   but never written by any code) are never sources: the helper uses a positive whitelist, so any
--   state other than generated/edited is excluded by default. Sessions of other series, detached
--   sessions and sessions after the target date are never selected, regardless of physical slot.
--   Capacity plays no part; whether copying happens at all is still decided only by roster_policy.
--
-- _generate_series_occurrence_claim is otherwise unchanged (same body except it calls the helper).
-- The helper is internal: EXECUTE is revoked from PUBLIC/anon/authenticated. No ledger backfill, no
-- data is modified, and existing occurrences/sessions/registrations are untouched.

create or replace function public._series_roster_source_session(p_series_id uuid, p_occurrence_date date)
returns uuid
language sql
stable
set search_path to 'public'
as $function$
  select c.session_id
  from (
    -- Ledger-era occurrences (primary source of logical history).
    select o.training_session_id as session_id, o.template_occurrence_date as logical_date, 0 as priority
    from public.session_series_occurrences o
    join public.training_sessions t on t.id = o.training_session_id
    where o.series_id = p_series_id
      and o.state in ('generated', 'edited')
      and o.template_occurrence_date < p_occurrence_date
      and t.series_id = p_series_id
      and t.series_detached = false
      and t.session_date < p_occurrence_date
    union all
    -- Legacy sessions that predate the ledger (never backfilled): compatibility fallback.
    select t.id, t.session_date, 1
    from public.training_sessions t
    where t.series_id = p_series_id
      and t.series_occurrence_id is null
      and t.series_detached = false
      and t.session_date < p_occurrence_date
  ) c
  order by c.logical_date desc, c.priority asc
  limit 1;
$function$;


CREATE OR REPLACE FUNCTION public._generate_series_occurrence_claim(p_series_id uuid, p_occurrence_date date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if exists (
    select 1 from public.training_sessions t
    where t.coach_id = s.coach_id and t.session_date = p_occurrence_date and t.start_time = s.start_time
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
        -- Source of the roster: the latest earlier logical occurrence of THIS series (see
        -- _series_roster_source_session). The ledger is primary; legacy sessions that predate it
        -- (never backfilled) are the fallback.
        v_prev_session := public._series_roster_source_session(p_series_id, p_occurrence_date);
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

    else
      -- Unknown/unexpected unique violation: do not misclassify, propagate to the caller's
      -- existing per-series exception handler.
      raise;
    end if;
  end;
end;
$function$;

-- Internal helper: not callable by clients (the generator calling it is a definer owned by postgres).
revoke execute on function public._series_roster_source_session(uuid, date) from public, anon, authenticated;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public._series_roster_source_session(uuid, date)'::regprocedure, 'EXECUTE')
       or has_function_privilege(v_role, 'public._generate_series_occurrence_claim(uuid, date)'::regprocedure, 'EXECUTE') then
      raise exception 'series generator internals must not be executable by %', v_role;
    end if;
  end loop;
end $$;
