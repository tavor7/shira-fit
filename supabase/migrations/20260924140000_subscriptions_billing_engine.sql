-- Subscription Management — Phase 3: billing engine.
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md.
--
-- Scope: immediate-first-charge + monthly billing-period generation, actual-calendar-day
-- proration for start/stop/freeze, retroactive reversal+correction for already-charged periods,
-- idempotency (billing-period identity + source_event_id), and the daily cron job. No CRUD RPCs
-- (create/freeze/stop/edit/delete/reactivate_subscription) and no impact-preview flow — those
-- remain Phase 4, per the approved plan's phase split. Since those RPCs don't exist yet, the
-- retroactive-correction path built here is exercised in tests by directly writing a freeze row
-- or a version's stopped_effective_date (exactly what a future Phase 4 RPC will do) and then
-- calling the same correction function Phase 4 will call.
--
-- Reuses Phase 1's subscription_next_anchor_date and subscription_billing_periods/
-- subscription_charges schema verbatim; no schema changes in this migration beyond what Phase 1
-- already created.

-- ---------------------------------------------------------------------------
-- 1. subscription_billing_period_unfrozen_days — pure calendar-day calculation helper.
--
-- Given a period [p_period_start, p_period_end) and a version's own stop/end boundaries, returns
-- the version-window actually in force within the period, and how many of those days are NOT
-- covered by any (non-cancelled) freeze. All in actual calendar days — never assumes 30-day
-- months, matching the plan's explicit requirement.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_billing_period_unfrozen_days(
  p_subscription_id uuid,
  p_period_start date,
  p_period_end date,
  p_stopped_effective_date date,
  p_plan_end_date date
)
returns table (
  total_days int,
  window_start date,
  window_end date,
  unfrozen_days int
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      p_period_start as window_start,
      greatest(
        p_period_start,
        least(
          p_period_end,
          coalesce(p_stopped_effective_date, p_period_end),
          coalesce(p_plan_end_date + 1, p_period_end)
        )
      ) as window_end
  ),
  frozen as (
    -- The `filter` clause is load-bearing, not cosmetic: GREATEST/LEAST in Postgres *ignore*
    -- NULL arguments instead of propagating them (documented behavior, easy to miss), so
    -- without it, the LEFT JOIN's unmatched (all-NULL) row when there are zero freezes would
    -- compute least(NULL, window_end)=window_end and greatest(NULL, window_start)=window_start,
    -- i.e. "frozen for the entire window" instead of "no freeze at all" — a real bug caught by
    -- testing (Test B1 returned a ₪0 charge for a plain, freeze-free subscription until this
    -- fix). Filtering out the unmatched row before summing restores the correct "no freeze"
    -- meaning of a LEFT JOIN miss.
    select
      coalesce(sum(
        greatest(0,
          least(f.freeze_until + 1, b.window_end) - greatest(f.freeze_from, b.window_start)
        )
      ) filter (where f.freeze_from is not null), 0)::int as frozen_days
    from bounds b
    left join public.subscription_freezes f
      on f.subscription_id = p_subscription_id
      and f.cancelled_at is null
      and f.freeze_from < b.window_end
      and f.freeze_until >= b.window_start
  )
  select
    (p_period_end - p_period_start)::int as total_days,
    b.window_start,
    b.window_end,
    greatest(0, (b.window_end - b.window_start) - fr.frozen_days)::int as unfrozen_days
  from bounds b, frozen fr;
$$;

comment on function public.subscription_billing_period_unfrozen_days(uuid, date, date, date, date) is
  'Actual-calendar-day window/freeze math for one billing period. window_end already accounts for '
  'stopped_effective_date (exclusive) and plan_end_date (inclusive, hence +1). unfrozen_days '
  'subtracts every non-cancelled freeze day inside that window. Pure/no writes.';

-- ---------------------------------------------------------------------------
-- 2. subscription_generate_or_correct_billing_period — the one shared function for both:
--    (a) fresh generation of a not-yet-billed period (called by the daily job, p_source_event_id
--        NULL), and (b) retroactive correction of an ALREADY-billed period after a freeze/stop/
--        edit is applied after the fact (will be called by Phase 4's freeze/stop/edit RPCs,
--        p_source_event_id = the freeze/version id that caused the correction).
--
-- Idempotency:
--  - Billing-period identity: INSERT ... ON CONFLICT (subscription_id, period_start) DO NOTHING —
--    the existing subscription_billing_periods unique constraint from Phase 1 is the anchor, so a
--    concurrent/duplicate call for the same period always converges on the same row.
--  - Original-charge identity: the existing partial unique index on subscription_charges
--    (billing_period_id) WHERE charge_type IN ('recurring','proration') guarantees at most one
--    "original" charge per period — this function inserts into that slot only when none exists.
--  - Correction identity: source_event_id is checked before writing a reversal — if a reversal
--    already exists for that exact source_event_id, this is a retry of an already-applied
--    correction and the call is a no-op. The existing (source_event_id, charge_type) partial
--    unique index from Phase 1 backstops this against a true concurrent race.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_generate_or_correct_billing_period(
  p_subscription_id uuid,
  p_version_id uuid,
  p_period_start date,
  p_period_end date,
  p_source_event_id uuid default null,
  p_correction_charge_type public.subscription_charge_type default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bp_id uuid;
  v_created_period boolean := false;
  v_version public.subscription_versions%rowtype;
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_days record;
  v_new_amount numeric(12, 2);
  v_new_type public.subscription_charge_type;
  v_existing public.subscription_charges%rowtype;
begin
  select * into v_version from public.subscription_versions where id = p_version_id;
  if not found then
    return json_build_object('ok', false, 'error', 'version_not_found');
  end if;
  if v_version.subscription_id <> p_subscription_id then
    return json_build_object('ok', false, 'error', 'version_subscription_mismatch');
  end if;

  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  insert into public.subscription_billing_periods (subscription_id, version_id, period_start, period_end)
  values (p_subscription_id, p_version_id, p_period_start, p_period_end)
  on conflict (subscription_id, period_start) do nothing
  returning id into v_bp_id;

  if v_bp_id is null then
    select id into v_bp_id
    from public.subscription_billing_periods
    where subscription_id = p_subscription_id and period_start = p_period_start;
  else
    v_created_period := true;
  end if;

  select * into v_days
  from public.subscription_billing_period_unfrozen_days(
    p_subscription_id, p_period_start, p_period_end,
    v_version.stopped_effective_date, v_version.plan_end_date
  );

  if v_days.total_days > 0
     and v_days.unfrozen_days = v_days.total_days
     and v_days.window_start = p_period_start
     and v_days.window_end = p_period_end
  then
    v_new_type := 'recurring';
    v_new_amount := round(v_version.monthly_price_ils, 2);
  else
    if v_days.total_days = 0 then
      v_new_amount := 0;
    else
      v_new_amount := round(v_version.monthly_price_ils * v_days.unfrozen_days / v_days.total_days, 2);
    end if;
    -- Organic (never-before-billed) partial period is plain 'proration'. A correction of an
    -- ALREADY-billed period must use a type outside the partial unique index's guarded set
    -- ('recurring','proration') so the replacement charge can coexist with the untouched
    -- original row — the caller supplies which (freeze_credit / stop_proration).
    v_new_type := case when v_created_period then 'proration'::public.subscription_charge_type
                       else p_correction_charge_type end;
  end if;

  select * into v_existing
  from public.subscription_charges
  where billing_period_id = v_bp_id and charge_type in ('recurring', 'proration')
  limit 1;

  if not found then
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
    ) values (
      v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual, v_new_amount, v_new_type, null
    );
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'created',
      'amount_ils', v_new_amount, 'charge_type', v_new_type
    );
  end if;

  if v_existing.amount_ils = v_new_amount then
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'unchanged', 'amount_ils', v_existing.amount_ils
    );
  end if;

  -- Retroactive correction of an already-billed period.
  if p_correction_charge_type is null then
    return json_build_object('ok', false, 'error', 'correction_charge_type_required');
  end if;

  if p_source_event_id is not null and exists (
    select 1 from public.subscription_charges
    where source_event_id = p_source_event_id and charge_type = 'reversal'
  ) then
    return json_build_object('ok', true, 'billing_period_id', v_bp_id, 'action', 'already_corrected');
  end if;

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    -v_existing.amount_ils, 'reversal', v_existing.id, p_source_event_id
  );

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    v_new_amount, p_correction_charge_type, p_source_event_id
  );

  return json_build_object(
    'ok', true, 'billing_period_id', v_bp_id, 'action', 'corrected',
    'amount_ils', v_new_amount, 'charge_type', p_correction_charge_type,
    'reversed_ils', v_existing.amount_ils
  );
exception
  when unique_violation then
    -- A concurrent call for the same source_event_id (or the same billing period's original
    -- charge slot) lost the race; the other call already produced the correct, idempotent result.
    return json_build_object('ok', true, 'action', 'concurrent_noop');
end;
$$;

comment on function public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type) is
  'Shared generate-or-correct entry point for one billing period. p_source_event_id NULL = fresh '
  'generation (daily job); non-NULL = retroactive correction of an already-billed period, caller '
  'must also pass p_correction_charge_type (freeze_credit / stop_proration).';

-- ---------------------------------------------------------------------------
-- 3. generate_due_subscription_charges — the daily job.
--
-- For every subscription with a current (effective_to IS NULL) version, walks forward from the
-- last billing_periods row (or plan_start_date if none exist yet — this is what makes the FIRST
-- charge "immediate": with no create_subscription RPC in this phase, a subscription's very first
-- period is simply picked up here the first time this job runs on/after plan_start_date, matching
-- the plan's explicit fallback for a future plan_start_date), generating one period per anchor
-- step until the next period would start in the future. A subscription past its stop date, or
-- past its plan_end_date, or tombstoned, generates no further periods once fully elapsed.
-- ---------------------------------------------------------------------------

create or replace function public.generate_due_subscription_charges()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public._studio_today_date();
  r record;
  v_next_start date;
  v_next_end date;
  v_periods_touched int := 0;
  v_res json;
begin
  for r in
    select s.id as subscription_id, v.id as version_id, v.anchor_day, v.plan_start_date,
           v.stopped_effective_date, v.plan_end_date
    from public.subscriptions s
    join public.subscription_versions v
      on v.subscription_id = s.id and v.effective_to is null
    where s.deleted_at is null
      and v.plan_start_date <= v_today
  loop
    loop
      select bp.period_start into v_next_start
      from public.subscription_billing_periods bp
      where bp.subscription_id = r.subscription_id
      order by bp.period_start desc
      limit 1;

      if v_next_start is null then
        v_next_start := r.plan_start_date;
      else
        v_next_start := public.subscription_next_anchor_date(r.anchor_day, v_next_start);
      end if;

      exit when v_next_start > v_today;

      -- Nothing left to bill once a period would start entirely at/after the stop date, or
      -- entirely after plan_end_date.
      exit when r.stopped_effective_date is not null and v_next_start >= r.stopped_effective_date;
      exit when r.plan_end_date is not null and v_next_start > r.plan_end_date;

      v_next_end := public.subscription_next_anchor_date(r.anchor_day, v_next_start);

      v_res := public.subscription_generate_or_correct_billing_period(
        r.subscription_id, r.version_id, v_next_start, v_next_end, null, null
      );
      if coalesce((v_res->>'ok')::boolean, false) then
        v_periods_touched := v_periods_touched + 1;
      end if;
    end loop;
  end loop;

  return json_build_object('ok', true, 'periods_touched', v_periods_touched);
end;
$$;

comment on function public.generate_due_subscription_charges() is
  'Daily billing job: generates every not-yet-billed, now-due subscription_billing_periods row '
  '(catching up multiple overdue periods per run if needed) via '
  'subscription_generate_or_correct_billing_period. Idempotent — safe to run twice or '
  'concurrently for the same period.';

-- Meant to run only via pg_cron / internal `perform` calls / the service-role Edge Function
-- below — never client-callable. Matches open_next_week_sessions_if_due_core's exact grant
-- pattern (20260627200000_weekly_registration_open_studio_timezone.sql), since this function,
-- like that one, is also invoked via supabase.rpc() from an Edge Function using the service role.
revoke all on function public.generate_due_subscription_charges() from public;
grant execute on function public.generate_due_subscription_charges() to service_role;
grant execute on function public.generate_due_subscription_charges() to postgres;

-- ---------------------------------------------------------------------------
-- 4. Cron wiring.
--
-- generate_due_subscription_charges() is pure SQL/database work with no third-party HTTP calls
-- and no need for a Deno/service-role execution context, so it follows the simpler
-- dispatch_due_session_push_reminders convention (cron -> SQL function directly, no Edge
-- Function hop) rather than open-weekly-registrations' vault-secret + net.http_post + Edge
-- Function pattern (which exists specifically for jobs that DO need an Edge Function's own
-- logic/HTTP capabilities). Both are real, established conventions in this repo; this is the
-- better fit for a pure-DB job. See the checkpoint report for why an Edge Function
-- (generate-subscription-charges) is nonetheless also included, invoking the same underlying
-- logic, so this stays consistent with the plan's literal wording and gives the same
-- HTTP-triggerable / observable surface as open-weekly-registrations for ops use if ever needed.
create extension if not exists pg_cron;

do $$
declare
  v_job_id int;
begin
  select j.jobid into v_job_id from cron.job j where j.jobname = 'generate-subscription-charges' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  -- Once daily, 03:00 UTC (well after studio-local midnight in Asia/Jerusalem, matching the
  -- once-daily cadence style of push-session-reminders' fixed schedule).
  perform cron.schedule(
    'generate-subscription-charges',
    '0 3 * * *',
    $job$select public.generate_due_subscription_charges();$job$
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Edge Function invoker, matching open-weekly-registrations' exact vault-secret pattern, for
--    an HTTP-triggerable / independently-observable path to the same logic (ops convenience,
--    not the actual cron trigger — the cron job above calls the SQL function directly per §4).
--
-- One-time setup (run in Supabase SQL editor after deploy), same shape as
-- open-weekly-registrations:
--   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/generate-subscription-charges', 'generate_subscription_charges_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'generate_subscription_charges_secret');
-- If secrets are missing, this no-ops safely (same as the existing pattern).
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;

create or replace function public.invoke_generate_subscription_charges_edge()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds
  where ds.name = 'generate_subscription_charges_url'
  limit 1;

  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'generate_subscription_charges_secret'
  limit 1;

  if v_url is null or v_secret is null
     or length(trim(v_url)) < 10
     or length(trim(v_secret)) < 4
  then
    return;
  end if;

  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(v_secret)
    ),
    body := jsonb_build_object('ts', now()::text)
  );
end;
$$;

comment on function public.invoke_generate_subscription_charges_edge() is
  'Optional HTTP-triggerable path to generate_due_subscription_charges() via the '
  'generate-subscription-charges Edge Function, mirroring invoke_open_weekly_registrations_edge. '
  'Not what the cron schedule above actually calls (that calls the SQL function directly).';
