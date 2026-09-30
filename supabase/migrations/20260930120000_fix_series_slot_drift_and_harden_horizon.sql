-- Recurring-session correctness fix (full sweep, not isolated patches):
--
-- 1) staff_update_session_series_scope: "this occurrence only" edits that change
--    start_time and/or coach_id (not just session_date) move the occurrence off its
--    generated template slot (date, start_time, coach_id). _generate_series_occurrences
--    keys its "does this slot already exist" check on the *template's* start_time/coach_id,
--    so a coach/time-only change (date unchanged) left the original slot empty and
--    unprotected -> the generator recreated the original "ghost" occurrence on the next
--    horizon run. Fixed by protecting the vacated date via the existing skip_dates
--    mechanism whenever the edit moves the occurrence off its template slot, not only
--    when session_date itself changes.
--
-- 2) One-time backfill: retroactively protect already-affected detached occurrences,
--    derived from the invariant (a detached occurrence sitting on a valid template date
--    whose start_time/coach_id diverges from its series' template must have that date
--    protected), not from a hardcoded list/count.
--
-- 3) maintain_session_series_horizon(): per-series exception isolation so one series'
--    failure (e.g. a unique-slot conflict) cannot abort horizon generation for every
--    other series. Failures are logged to user_activity_events (existing audit-log
--    convention) with series_id/operation/error/timestamp, not swallowed and not
--    returned to the caller.
--
-- 4) Real server-side scheduling via pg_cron (existing convention, see
--    generate-subscription-charges / open-weekly-registrations jobs), so correctness no
--    longer depends on a coach/manager opening the Sessions screen. The client-triggered
--    call remains as a best-effort fast-path fallback.

-- ---------------------------------------------------------------------------
-- 1) staff_update_session_series_scope: protect the vacated template slot whenever
--    a "this occurrence only" edit moves the occurrence off (date, start_time, coach_id).
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
  v_series public.session_series%rowtype;
  v_scope text;
  v_dur int;
  v_new_date date;
  v_old_date date;
  v_new_time time;
  v_new_coach uuid;
  v_slot_moved boolean;
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

  select * into v_series from public.session_series where id = v_sess.series_id;

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

    -- The generator's "does this template slot already exist" check keys off the
    -- series' own (start_time, coach_id), not this row's post-edit values. Any edit
    -- that leaves this row's (date, start_time, coach_id) no longer matching what the
    -- template would generate on v_old_date must permanently protect v_old_date via
    -- skip_dates, the existing (canonical) exception mechanism -- otherwise the base
    -- occurrence regenerates there on the next horizon run.
    v_new_time := coalesce(p_start_time, v_sess.start_time);
    v_new_coach := coalesce(p_coach_id, v_sess.coach_id);
    v_slot_moved := (v_new_date <> v_old_date)
      or (v_series.id is not null and v_new_time <> v_series.start_time)
      or (v_series.id is not null and v_new_coach <> v_series.coach_id);

    if v_slot_moved then
      perform public._series_add_skip_date(v_sess.series_id, v_old_date);
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
      series_detached = true
      -- keep series_id: deletion/skip-date bookkeeping still needs the link
    where id = p_session_id;

    return json_build_object('ok', true, 'scope', 'this');
  end if;

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

  -- Apply template fields to future occurrences; keep each row's own session_date.
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

  -- Date changes apply only to the edited occurrence (other weeks stay on their dates).
  if v_new_date <> v_old_date then
    if exists (
      select 1 from public.training_sessions t
      where t.series_id = v_sess.series_id
        and t.session_date = v_new_date
        and t.id <> p_session_id
    ) then
      return json_build_object('ok', false, 'error', 'series_date_conflict');
    end if;

    -- prevent base occurrence from regenerating at the old date
    perform public._series_add_skip_date(v_sess.series_id, v_old_date);

    update public.training_sessions
    set
      session_date = v_new_date,
      series_detached = true
      -- keep series_id
    where id = p_session_id;
  else
    -- still mark as detached so future edits don't propagate
    update public.training_sessions
    set series_detached = true
    where id = p_session_id;
  end if;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) One-time backfill, invariant-driven (not a hardcoded row list/count):
--    a detached, series-linked occurrence sitting on one of its series' valid
--    weekly template dates, whose start_time/coach_id diverges from the series
--    template, must have that date protected in skip_dates so the template
--    occurrence cannot regenerate there. Safe to run more than once: skip_dates
--    is de-duplicated, and rows already matching the template (or already
--    recorded) are simply no-ops.
-- ---------------------------------------------------------------------------
with divergent as (
  select t.id as session_id, t.series_id, t.session_date
  from public.training_sessions t
  join public.session_series s on s.id = t.series_id
  where t.series_detached = true
    and t.session_date >= s.anchor_date
    and mod((t.session_date - s.anchor_date), 7) = 0
    and (t.start_time <> s.start_time or t.coach_id <> s.coach_id)
)
update public.session_series s
set skip_dates = (
  select array_agg(distinct d order by d)
  from (
    select unnest(coalesce(s.skip_dates, '{}'::date[])) as d
    union all
    select d.session_date from divergent d where d.series_id = s.id
  ) u
)
where s.id in (select series_id from divergent);

-- Clean up any ghost duplicates that may already have been generated before this fix
-- (safe: never removes a row that has an active roster when the other side does too).
select public._reconcile_slot_duplicate_sessions();

-- ---------------------------------------------------------------------------
-- 3) maintain_session_series_horizon(): per-series exception isolation + logging.
--    Split into an unauthenticated "core" (callable by cron / the authenticated RPC)
--    so a single series failure can't take down the whole horizon run, and so
--    failures are recorded (not silently dropped) without leaking raw DB errors
--    to the calling client.
-- ---------------------------------------------------------------------------
create or replace function public._maintain_session_series_horizon_core()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_total int := 0;
  v_failed int := 0;
  v_n int;
  v_from date;
  v_to date;
  v_reconciled int := 0;
begin
  v_from := public._studio_today_date();
  v_to := public._series_horizon_end();

  for s in
    select id from public.session_series
    where status = 'active' and repeat_mode = 'ongoing'::public.session_series_repeat_mode
  loop
    begin
      v_n := public._generate_series_occurrences(s.id, v_from, v_to);
      v_total := v_total + coalesce(v_n, 0);
    exception when others then
      v_failed := v_failed + 1;
      perform public._insert_activity_event(
        null,
        'series_horizon_generation_failed',
        'session_series',
        s.id::text,
        jsonb_build_object(
          'operation', 'maintain_session_series_horizon',
          'error', sqlerrm,
          'sqlstate', sqlstate,
          'occurred_at', now()
        )
      );
    end;
  end loop;

  begin
    v_reconciled := public._reconcile_slot_duplicate_sessions();
  exception when others then
    perform public._insert_activity_event(
      null,
      'series_horizon_reconcile_failed',
      'session_series',
      null,
      jsonb_build_object(
        'operation', 'reconcile_series_duplicate_sessions',
        'error', sqlerrm,
        'sqlstate', sqlstate,
        'occurred_at', now()
      )
    );
  end;

  return json_build_object('ok', true, 'created', v_total, 'reconciled', v_reconciled, 'failed', v_failed);
end;
$$;

comment on function public._maintain_session_series_horizon_core() is
  'Unauthenticated horizon-generation core: per-series exception isolation, failures logged to user_activity_events. Called by the authenticated RPC and by the cron job.';

-- Authenticated client-facing RPC: keep existing auth checks, delegate to the core.
create or replace function public.maintain_session_series_horizon()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  return public._maintain_session_series_horizon_core();
end;
$$;

grant execute on function public.maintain_session_series_horizon() to authenticated;

-- Cron-facing entry point: no user session exists when pg_cron invokes this, so it
-- does not (and must not) check auth.uid(); restricted to service_role/postgres only,
-- matching the existing generate_due_subscription_charges() convention.
create or replace function public.cron_maintain_session_series_horizon()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._maintain_session_series_horizon_core();
end;
$$;

comment on function public.cron_maintain_session_series_horizon() is
  'pg_cron entry point for recurring-session horizon maintenance. Idempotent and safe to run concurrently with client-triggered maintain_session_series_horizon() -- both rely on _generate_series_occurrences'' existence check plus the training_sessions_coach_slot_uidx unique index; a losing concurrent insert raises a unique violation which is caught and logged, not fatal.';

revoke all on function public.cron_maintain_session_series_horizon() from public;
revoke all on function public.cron_maintain_session_series_horizon() from authenticated;
grant execute on function public.cron_maintain_session_series_horizon() to service_role;
grant execute on function public.cron_maintain_session_series_horizon() to postgres;

-- ---------------------------------------------------------------------------
-- 4) Real server-side schedule (existing pg_cron convention). Daily is enough for a
--    35-day rolling horizon; this removes the dependency on someone opening the
--    Sessions screen for correctness. The client call in coach/manager sessions.tsx
--    stays as a best-effort fast-path fallback.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.unschedule(jobid)
from cron.job
where jobname = 'maintain-session-series-horizon';

select cron.schedule(
  'maintain-session-series-horizon',
  '15 2 * * *',
  $job$select public.cron_maintain_session_series_horizon();$job$
);
