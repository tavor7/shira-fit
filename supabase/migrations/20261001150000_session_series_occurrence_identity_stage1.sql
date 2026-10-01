-- Stage 1 of the recurring-session occurrence-identity redesign.
--
-- Root cause being fixed: the generator (_generate_series_occurrences) has always decided
-- whether a logical series occurrence "already exists" by checking physical slot occupancy
-- (session_date, start_time, coach_id). Two independent production incidents (2026-10-04
-- coach change Lotem->Shira, 2026-10-06 time change 18:00->19:00) proved this is unsafe
-- whenever a second active series shares the same (coach, start_time) weekly phase as the
-- series being edited: a "this occurrence only" edit correctly protects its own series via
-- skip_dates, but nothing stops a *different* series from generating into the slot the edit
-- just vacated, because skip_dates is per-series and the generator's existence check is
-- slot-based, not identity-based.
--
-- This migration introduces an explicit occurrence ledger (session_series_occurrences) keyed
-- by (series_id, template_occurrence_date) -- the logical identity of an occurrence -- plus a
-- second unique constraint on (template_coach_id, template_start_time, template_occurrence_date)
-- that is the actual fix: at most one series may ever own a given logical template slot+date.
--
-- REVISED SCOPE (forward-only requirement): historical completeness is explicitly NOT a
-- deployment condition. The correctness target is: from the moment this migration is applied,
-- every "this occurrence only" edit or delete atomically establishes durable logical-occurrence
-- protection -- using the PRE-EDIT/PRE-DELETE values as the template identity, in the SAME
-- transaction as the physical change -- regardless of whether that occurrence ever had a ledger
-- row before. Historical rows with no prior ledger entry are left exactly as they are,
-- permanently, with no backfill of any kind -- this migration never writes to an existing
-- training_sessions row, so nothing about historical state is ever a precondition for the fix.
--
-- Scope of this migration:
--   - new ledger table + training_sessions.series_occurrence_id (additive, inert for old code)
--   - NO backfill: no existing training_sessions row is written to by this migration, not even
--     to set series_occurrence_id. Historical rows (including the known Shira/Lotem duplicate)
--     stay exactly as they are, permanently unlinked, unless/until a future edit or delete
--     touches them -- at which point the edit/delete RPC itself establishes the link using
--     pre-change values, same as it would for any other row.
--   - rewritten _generate_series_occurrences (single-series entry point, used by
--     staff_create_session_series) and _maintain_session_series_horizon_core (cross-series
--     entry point, used by cron + client) to use the new claim-based algorithm
--   - staff_update_session_series_scope / staff_delete_session_series_scope: the 'this' scope
--     branches now atomically establish-or-retrieve the occurrence's ledger entry, using
--     pre-edit/pre-delete values, in the same transaction as the physical change -- this is
--     the actual fix for both real incidents (an edit/delete must self-protect going forward,
--     not depend on backfill ever having run for that row). skip_dates/series_detached are
--     kept, unchanged, as compatibility/rollback defense-in-depth.
--   - explicit, distinguishable outcomes: already_handled / created / series_logical_conflict /
--     series_slot_conflict / unresolved_series_ownership -- nothing is ever silently absorbed
--
-- Explicitly NOT in scope for this migration:
--   - the 'future' scope branches of the edit/delete RPCs are unchanged.
--   - staff_create_session_series's bulk roster-copy path is unchanged.
--   - the client-triggered maintainSessionSeriesHorizon() call is untouched.
--   - the 11 known overlapping production series pairs are NOT reconciled by this migration --
--     by design, pre-existing cross-series conflicts coexist as legacy, unlinked state; the
--     new unique constraints are never challenged by them because they're never force-linked.
--   - no existing training_sessions row, registration, waitlist entry, or skip_dates array is
--     modified by this migration. No notification is sent by this migration.
--   - _reconcile_slot_duplicate_sessions is kept, unchanged, still called at the end of horizon
--     maintenance as a defense-in-depth cleanup (it can no longer be triggered by this bug
--     class going forward for NEW edits, but remains valid for other duplicate causes).

-- ---------------------------------------------------------------------------
-- 1) Ledger table
-- ---------------------------------------------------------------------------
create table if not exists public.session_series_occurrences (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.session_series (id) on delete cascade,
  template_occurrence_date date not null,
  template_coach_id uuid not null,
  template_start_time time not null,
  state text not null check (state in ('claimed', 'generated', 'edited', 'skipped', 'deleted')),
  training_session_id uuid references public.training_sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_series_occurrences_materialized_requires_session
    check (state not in ('generated', 'edited') or training_session_id is not null)
);

comment on table public.session_series_occurrences is
  'Durable logical-occurrence ledger for recurring session series. Identity is (series_id,
   template_occurrence_date); at most one series may ever own a given (template_coach_id,
   template_start_time, template_occurrence_date). state=''claimed'' is a transient,
   intra-transaction-only state and must never be observed committed by normal execution --
   see _generate_series_occurrence_claim().';

create unique index if not exists session_series_occurrences_identity_uidx
  on public.session_series_occurrences (series_id, template_occurrence_date);

create unique index if not exists session_series_occurrences_logical_slot_uidx
  on public.session_series_occurrences (template_coach_id, template_start_time, template_occurrence_date);

create index if not exists session_series_occurrences_training_session_idx
  on public.session_series_occurrences (training_session_id)
  where training_session_id is not null;

drop trigger if exists session_series_occurrences_updated on public.session_series_occurrences;
create trigger session_series_occurrences_updated
  before update on public.session_series_occurrences
  for each row execute function public.set_updated_at();

alter table public.training_sessions
  add column if not exists series_occurrence_id uuid references public.session_series_occurrences (id);

create index if not exists training_sessions_series_occurrence_idx
  on public.training_sessions (series_occurrence_id)
  where series_occurrence_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Atomic single-occurrence claim + materialize primitive.
--
-- Transaction design (see engagement design review for full derivation):
--   - The identity claim and the physical materialization attempt live in ONE plpgsql block.
--   - If the claim insert itself hits the logical-slot unique index (a DIFFERENT series already
--     owns this template slot+date), nothing was ever inserted -- the statement itself raises,
--     the block has nothing to roll back, and we classify + log via GET STACKED DIAGNOSTICS
--     CONSTRAINT_NAME (never a generic catch-all).
--   - If the claim succeeds but the subsequent training_sessions insert hits the PHYSICAL slot
--     unique index, the SAME block's exception handler rolls back the entire block -- which
--     undoes BOTH the failed training_sessions insert AND the claim row that was inserted
--     earlier in this same block. No session_series_occurrences row survives a failed
--     materialization attempt. The conflict is then logged in the exception handler, which
--     runs AFTER the implicit rollback-to-savepoint, in the still-open outer transaction --
--     i.e. the log entry persists even though the occurrence claim did not.
--   - A committed state='generated'/'edited' row is therefore guaranteed by the CHECK
--     constraint above to always have a non-null training_session_id; state='claimed' is never
--     a valid terminal state of a row that successfully committed through normal execution.
-- ---------------------------------------------------------------------------
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
   created, already_handled, series_logical_conflict, series_slot_conflict, series_not_found.
   Never leaves a session_series_occurrences row for a failed materialization attempt.';

-- ---------------------------------------------------------------------------
-- 3) Single-series entry point (used by staff_create_session_series). Respects any
--    existing owner for a template slot+date (Case A) without attempting a cross-series
--    multi-candidate check -- that check only makes sense when evaluating multiple series
--    together, which is _maintain_session_series_horizon_core's job (section 4 below).
-- ---------------------------------------------------------------------------
create or replace function public._generate_series_occurrences(
  p_series_id uuid,
  p_from date,
  p_to date
)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.session_series%rowtype;
  v_d date;
  v_n int := 0;
  v_inserted int := 0;
  v_max_n int := 520;
  v_end date;
  v_outcome text;
  v_owner_series_id uuid;
begin
  select * into s from public.session_series where id = p_series_id;
  if not found or s.status <> 'active' then
    return 0;
  end if;

  v_end := p_to;
  if s.repeat_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_end := least(p_to, s.anchor_date + ((s.fixed_weeks - 1) * 7));
  elsif s.ended_from_date is not null then
    v_end := least(p_to, s.ended_from_date - 1);
  end if;

  while v_n < v_max_n loop
    v_d := s.anchor_date + (v_n * 7);
    exit when v_d > v_end;

    if v_d >= p_from and not (v_d = any (coalesce(s.skip_dates, '{}'::date[]))) then
      select o.series_id into v_owner_series_id
      from public.session_series_occurrences o
      where o.template_coach_id = s.coach_id
        and o.template_start_time = s.start_time
        and o.template_occurrence_date = v_d;

      if v_owner_series_id is null or v_owner_series_id = p_series_id then
        v_outcome := public._generate_series_occurrence_claim(p_series_id, v_d);
        if v_outcome = 'created' then
          v_inserted := v_inserted + 1;
        end if;
      end if;
      -- v_owner_series_id belonging to a DIFFERENT series: this series' own single-entry
      -- generation defers to the existing owner silently (Case A); no claim attempted, no
      -- conflict logged here -- this is expected/routine from this call's point of view (it
      -- is not asking "who should own this", only "generate my own series' schedule").
    end if;

    v_n := v_n + 1;
  end loop;

  return v_inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Cross-series horizon orchestration: the ownership pre-check (Case A/B/C) runs BEFORE
--    any series attempts a claim, so generator iteration order can never decide ownership
--    of a genuinely-contested, not-yet-owned future date.
-- ---------------------------------------------------------------------------
create or replace function public._maintain_session_series_horizon_core()
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_from date;
  v_to date;
  v_total int := 0;
  v_failed int := 0;
  v_reconciled int := 0;
  v_unresolved int := 0;
  slot record;
  s record;
  v_d date;
  v_n int;
  v_end date;
  v_owner_series_id uuid;
  v_candidates uuid[];
  v_outcome text;
  cleared_key text;
  cleared jsonb := '{}'::jsonb;  -- set of "series_id|date" strings cleared to claim
begin
  v_from := public._studio_today_date();
  v_to := public._series_horizon_end();

  -- Pass 1 (read-only): for every distinct (coach, start_time) slot family among active
  -- ongoing series, and every candidate date in the horizon, determine ownership BEFORE any
  -- series attempts to claim anything.
  for slot in
    select distinct coach_id, start_time
    from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    for v_d in
      select generate_series(v_from, v_to, interval '1 day')::date
    loop
      -- Case A: an owner already exists for this exact template slot+date (from backfill, a
      -- prior run, or a prior edit) -- nothing to resolve, the owning series proceeds normally
      -- via its own loop below.
      select o.series_id into v_owner_series_id
      from public.session_series_occurrences o
      where o.template_coach_id = slot.coach_id
        and o.template_start_time = slot.start_time
        and o.template_occurrence_date = v_d;

      if v_owner_series_id is not null then
        cleared := cleared || jsonb_build_object(v_owner_series_id::text || '|' || v_d::text, true);
        continue;
      end if;

      -- No owner yet. Who, among this slot family's active series, actually wants this date?
      select array_agg(ss.id) into v_candidates
      from public.session_series ss
      where ss.coach_id = slot.coach_id
        and ss.start_time = slot.start_time
        and ss.status = 'active'
        and ss.repeat_mode = 'ongoing'::public.session_series_repeat_mode
        and v_d >= ss.anchor_date
        and mod((v_d - ss.anchor_date), 7) = 0
        and not (v_d = any (coalesce(ss.skip_dates, '{}'::date[])))
        and (ss.ended_from_date is null or v_d < ss.ended_from_date);

      if v_candidates is null or array_length(v_candidates, 1) = 0 then
        continue;  -- nobody wants this date
      elsif array_length(v_candidates, 1) = 1 then
        cleared := cleared || jsonb_build_object(v_candidates[1]::text || '|' || v_d::text, true);
      else
        v_unresolved := v_unresolved + 1;
        perform public._insert_activity_event(
          null, 'series_unresolved_ownership', 'session_series', null,
          jsonb_build_object(
            'template_coach_id', slot.coach_id,
            'template_start_time', slot.start_time,
            'template_occurrence_date', v_d,
            'candidate_series_ids', to_jsonb(v_candidates)
          )
        );
        -- neither candidate is cleared; no claim attempted for anyone on this date
      end if;
    end loop;
  end loop;

  -- Pass 2: per-series generation, claiming only dates cleared in pass 1. Per-series exception
  -- isolation unchanged from the prior hardening migration.
  for s in
    select * from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    begin
      v_end := v_to;
      if s.ended_from_date is not null then
        v_end := least(v_to, s.ended_from_date - 1);
      end if;

      v_n := 0;
      while true loop
        v_d := s.anchor_date + (v_n * 7);
        exit when v_d > v_end;
        v_n := v_n + 1;

        continue when v_d < v_from;
        continue when v_d = any (coalesce(s.skip_dates, '{}'::date[]));
        cleared_key := s.id::text || '|' || v_d::text;
        continue when not coalesce((cleared -> cleared_key)::boolean, false);

        v_outcome := public._generate_series_occurrence_claim(s.id, v_d);
        if v_outcome = 'created' then
          v_total := v_total + 1;
        end if;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      perform public._insert_activity_event(
        null, 'series_horizon_generation_failed', 'session_series', s.id::text,
        jsonb_build_object(
          'operation', 'maintain_session_series_horizon', 'error', sqlerrm,
          'sqlstate', sqlstate, 'occurred_at', now()
        )
      );
    end;
  end loop;

  begin
    v_reconciled := public._reconcile_slot_duplicate_sessions();
  exception when others then
    perform public._insert_activity_event(
      null, 'series_horizon_reconcile_failed', 'session_series', null,
      jsonb_build_object(
        'operation', 'reconcile_series_duplicate_sessions', 'error', sqlerrm,
        'sqlstate', sqlstate, 'occurred_at', now()
      )
    );
  end;

  return json_build_object(
    'ok', true, 'created', v_total, 'reconciled', v_reconciled,
    'failed', v_failed, 'unresolved_ownership', v_unresolved
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b) No backfill. An earlier version of this migration backfilled historical rows'
--     series_occurrence_id deterministically; that is deliberately removed. Writing to an
--     existing training_sessions row -- even just an auxiliary FK, never date/time/coach/
--     registrations -- is still a modification of an existing production row, which the
--     revised, forward-only product requirement for this deployment forbids outright. No
--     historical row is read-modified by this migration. Historical rows (including the
--     known Shira/Lotem duplicate and the other old unlinked rows) are left with
--     series_occurrence_id = null exactly as they are; they are not a deployment blocker (see
--     header). The physical pre-existence short-circuit added to
--     _generate_series_occurrence_claim above is what keeps horizon maintenance idempotent and
--     quiet for this already-existing state without ever backfilling it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5) Ledger-aware "this occurrence only" edit. This is the actual forward-looking fix: an
--    edit atomically establishes-or-retrieves the occurrence's durable logical identity using
--    PRE-EDIT values, in the SAME transaction as the physical change, regardless of whether a
--    ledger row existed before. Once established, the ledger retains that ORIGINAL template
--    identity permanently, even as the physical session's coach/time/date subsequently change.
--
--    Cross-series protection: the claim attempt targets BOTH unique indexes at once (identity
--    AND logical-slot). If a sibling series already owns the original (coach,time,date) --
--    e.g. because IT was already linked by backfill or an earlier edit -- this occurrence
--    simply doesn't get (and doesn't need) its own new claim: the slot is already protected.
--    The physical edit is never blocked by this; only the ledger linkage is best-effort beyond
--    the occurrence's own identity claim.
--
--    skip_dates/series_detached writes are UNCHANGED, kept as compatibility/rollback defense.
--    The 'future' scope branch is unchanged (out of scope for this pass).
-- ---------------------------------------------------------------------------
create or replace function public.staff_update_session_series_scope(
  p_session_id uuid,
  p_scope text,
  p_session_date date,
  p_start_time time,
  p_coach_id uuid,
  p_max_participants int,
  p_duration_minutes int,
  p_is_open boolean,
  p_is_hidden boolean,
  p_is_kickbox boolean,
  p_custom_slot_price_ils numeric default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_dur int;
  v_new_date date;
  v_old_date date;
  v_occurrence_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  v_dur := greatest(1, coalesce(p_duration_minutes, 60));
  v_new_date := coalesce(p_session_date, v_sess.session_date);
  v_old_date := v_sess.session_date;

  if v_sess.series_id is null then
    update public.training_sessions
    set
      session_date = v_new_date,
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils
    where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    if v_new_date <> v_old_date then
      if exists (
        select 1 from public.training_sessions t
        where t.series_id = v_sess.series_id
          and t.session_date = v_new_date
          and t.id <> p_session_id
      ) then
        return json_build_object('ok', false, 'error', 'series_date_conflict');
      end if;
    end if;

    -- Forward-only fix: atomically establish or retrieve this occurrence's durable identity,
    -- using PRE-EDIT values, before applying the physical change. Never mutates any OTHER row.
    if v_sess.series_occurrence_id is not null then
      v_occurrence_id := v_sess.series_occurrence_id;
    else
      begin
        insert into public.session_series_occurrences (
          series_id, template_occurrence_date, template_coach_id, template_start_time,
          state, training_session_id
        )
        values (
          v_sess.series_id, v_old_date, v_sess.coach_id, v_sess.start_time, 'edited', p_session_id
        )
        on conflict (series_id, template_occurrence_date) do nothing
        returning id into v_occurrence_id;

        if v_occurrence_id is null then
          -- Identity already claimed (e.g. a concurrent claim for this exact series+date) --
          -- adopt the existing row rather than erroring; the physical edit still proceeds.
          select id into v_occurrence_id
          from public.session_series_occurrences
          where series_id = v_sess.series_id and template_occurrence_date = v_old_date;
        end if;
      exception when unique_violation then
        -- Cross-series logical-slot conflict: a SIBLING series already owns this exact
        -- original (coach,time,date) -- that slot is already protected by that claim. This
        -- occurrence stays unlinked (legacy); the physical edit is not blocked by this.
        v_occurrence_id := null;
      end;
    end if;

    -- Pre-existing skip_dates/series_detached protection, unchanged.
    if v_new_date <> v_old_date then
      update public.session_series
      set skip_dates = (
        select array_agg(distinct d order by d)
        from (
          select unnest(coalesce(skip_dates, '{}'::date[])) as d
          union all
          select v_old_date
        ) u
      )
      where id = v_sess.series_id;
    end if;

    update public.training_sessions
    set
      session_date = v_new_date,
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils,
      series_detached = true,
      series_occurrence_id = coalesce(v_occurrence_id, v_sess.series_occurrence_id)
    where id = p_session_id;

    if v_occurrence_id is not null then
      update public.session_series_occurrences
      set state = 'edited'
      where id = v_occurrence_id and state <> 'edited';
    end if;

    return json_build_object('ok', true, 'scope', 'this');
  end if;

  -- 'future' scope: unchanged from the prior migration, not part of this pass's scope.
  update public.session_series
  set
    coach_id = coalesce(p_coach_id, coach_id),
    start_time = coalesce(p_start_time, start_time),
    duration_minutes = v_dur,
    max_participants = coalesce(p_max_participants, max_participants),
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils,
    updated_at = now()
  where id = v_sess.series_id;

  update public.training_sessions
  set
    start_time = coalesce(p_start_time, start_time),
    coach_id = coalesce(p_coach_id, coach_id),
    max_participants = coalesce(p_max_participants, max_participants),
    duration_minutes = v_dur,
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils
  where series_id = v_sess.series_id
    and session_date >= v_old_date
    and series_detached = false;

  if v_new_date <> v_old_date then
    if exists (
      select 1 from public.training_sessions t
      where t.series_id = v_sess.series_id
        and t.session_date = v_new_date
        and t.id <> p_session_id
    ) then
      return json_build_object('ok', false, 'error', 'series_date_conflict');
    end if;

    update public.session_series
    set skip_dates = (
      select array_agg(distinct d order by d)
      from (
        select unnest(coalesce(skip_dates, '{}'::date[])) as d
        union all
        select v_old_date
      ) u
    )
    where id = v_sess.series_id;

    update public.training_sessions
    set
      session_date = v_new_date,
      series_detached = true
    where id = p_session_id;
  else
    update public.training_sessions
    set series_detached = true
    where id = p_session_id;
  end if;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Ledger-aware "this occurrence only" delete. Same principle: atomically establish a
--    durable tombstone using PRE-DELETE values, in the SAME transaction as the delete, so
--    generation cannot recreate this occurrence AND a sibling series cannot claim the
--    vacated logical slot. skip_dates write is unchanged, kept for compatibility.
-- ---------------------------------------------------------------------------
create or replace function public.staff_delete_session_series_scope(
  p_session_id uuid,
  p_scope text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_occurrence_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  if v_sess.series_id is null then
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    -- Forward-only fix: atomically establish-or-retrieve a durable tombstone for this
    -- occurrence, using pre-delete values, before the physical delete. Protects both this
    -- series (never regenerates) and blocks a sibling series from claiming the vacated slot.
    if v_sess.series_occurrence_id is not null then
      update public.session_series_occurrences
      set state = 'deleted', training_session_id = null
      where id = v_sess.series_occurrence_id;
    else
      begin
        insert into public.session_series_occurrences (
          series_id, template_occurrence_date, template_coach_id, template_start_time, state
        )
        values (v_sess.series_id, v_sess.session_date, v_sess.coach_id, v_sess.start_time, 'deleted')
        on conflict (series_id, template_occurrence_date) do nothing
        returning id into v_occurrence_id;
      exception when unique_violation then
        -- A sibling series already owns this exact original slot -- it's already protected;
        -- the delete proceeds regardless.
        null;
      end;
    end if;

    -- Pre-existing skip_dates protection, unchanged.
    perform public._series_add_skip_date(v_sess.series_id, v_sess.session_date);

    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  -- 'future' scope: unchanged from the prior migration, not part of this pass's scope.
  update public.session_series
  set
    status = 'ended',
    ended_from_date = v_sess.session_date,
    updated_at = now()
  where id = v_sess.series_id;

  delete from public.training_sessions t
  where t.series_id = v_sess.series_id
    and t.session_date >= v_sess.session_date
    and t.series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;
