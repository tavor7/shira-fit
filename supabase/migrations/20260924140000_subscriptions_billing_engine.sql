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
-- 1. subscription_billing_period_segments / subscription_billing_period_amount — the unified
--    segmentation model, replacing the freeze-only subscription_billing_period_unfrozen_days
--    from the first draft of this migration.
--
-- Post-merge-audit architectural revision: a billing period can span more than one
-- subscription_versions row (a retroactive or future-dated edit can set a new version's
-- effective_from to any date, including one inside an already-generated or not-yet-generated
-- period). The ORIGINAL design priced an entire period from a single caller-supplied version_id
-- — that is a "one version owns the whole period" shortcut and is financially wrong the moment
-- more than one version is ever created for a subscription (which Phase 4's edit RPC will do).
--
-- The fix: split every period into calendar SEGMENTS at every financial-eligibility boundary —
-- version effective_from/effective_to, a version's own plan_start_date/plan_end_date/
-- stopped_effective_date, and every (non-cancelled) freeze's start/end — then price each segment
-- under whichever version is effective for it, sum the segments, and round ONCE at the end (not
-- per segment; see the rounding note on subscription_billing_period_amount). This is the ONE
-- place proration math lives now — subscription_generate_or_correct_billing_period no longer has
-- any separate/duplicated freeze-only or stop-only day-counting logic that could disagree with
-- this.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_billing_period_segments(
  p_subscription_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  segment_start date,
  segment_end date,
  version_id uuid,
  monthly_price_ils numeric,
  is_billable boolean,
  segment_days int
)
language sql
stable
security definer
set search_path = public
as $$
  with boundary_points as (
    -- The two period ends, plus every version/freeze boundary that falls STRICTLY inside the
    -- period (a boundary exactly on p_period_start or p_period_end needs no extra split point).
    select p_period_start as d
    union
    select p_period_end
    union
    select v.effective_from
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.effective_from > p_period_start and v.effective_from < p_period_end
    union
    select v.effective_to
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.effective_to is not null
      and v.effective_to > p_period_start and v.effective_to < p_period_end
    union
    select v.plan_start_date
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.plan_start_date > p_period_start and v.plan_start_date < p_period_end
    union
    select v.plan_end_date + 1
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.plan_end_date is not null
      and v.plan_end_date + 1 > p_period_start and v.plan_end_date + 1 < p_period_end
    union
    select v.stopped_effective_date
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.stopped_effective_date is not null
      and v.stopped_effective_date > p_period_start and v.stopped_effective_date < p_period_end
    union
    select f.freeze_from
    from public.subscription_freezes f
    where f.subscription_id = p_subscription_id and f.cancelled_at is null
      and f.freeze_from > p_period_start and f.freeze_from < p_period_end
    union
    select f.freeze_until + 1
    from public.subscription_freezes f
    where f.subscription_id = p_subscription_id and f.cancelled_at is null
      and f.freeze_until + 1 > p_period_start and f.freeze_until + 1 < p_period_end
  ),
  ordered as (
    select d, lead(d) over (order by d) as next_d
    from boundary_points
  ),
  segments as (
    select d as segment_start, next_d as segment_end
    from ordered
    where next_d is not null and next_d > d
  )
  select
    s.segment_start,
    s.segment_end,
    v.id as version_id,
    v.monthly_price_ils,
    (
      -- Billable = a version is effective for this segment, that version's own plan window
      -- covers it (plan_start_date inclusive, plan_end_date inclusive hence the <=, stop
      -- exclusive hence the strict <), AND no non-cancelled freeze covers it. Checking only
      -- segment_start is correct and sufficient because segments are constructed so that
      -- nothing (version, plan window, freeze) changes within a segment.
      v.id is not null
      and s.segment_start >= v.plan_start_date
      and (v.plan_end_date is null or s.segment_start <= v.plan_end_date)
      and (v.stopped_effective_date is null or s.segment_start < v.stopped_effective_date)
      and not exists (
        select 1 from public.subscription_freezes f
        where f.subscription_id = p_subscription_id and f.cancelled_at is null
          and f.freeze_from <= s.segment_start and f.freeze_until >= s.segment_start
      )
    ) as is_billable,
    (s.segment_end - s.segment_start)::int as segment_days
  from segments s
  left join public.subscription_versions v
    on v.subscription_id = p_subscription_id
    and v.effective_from <= s.segment_start
    and (v.effective_to is null or v.effective_to > s.segment_start)
  order by s.segment_start;
$$;

comment on function public.subscription_billing_period_segments(uuid, date, date) is
  'Splits [p_period_start, p_period_end) into calendar segments at every version/freeze boundary '
  'inside the period, each tagged with its effective version, that version''s price, whether it '
  'is billable (active window and not frozen), and its day count. The one authoritative source of '
  'per-day pricing/eligibility for a billing period — never bypassed by a single-version shortcut.';

create or replace function public.subscription_billing_period_amount(
  p_subscription_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  amount_ils numeric,
  is_full_recurring boolean
)
language sql
stable
security definer
set search_path = public
as $$
  -- Rounding rule: round the FINAL summed amount once, not each segment individually. Rounding
  -- per segment first would let independent segment-level rounding errors accumulate (e.g. three
  -- segments each rounded up by half a cent overstate the period by 1.5 cents versus rounding the
  -- exact sum once) — summing the exact (unrounded) per-segment fractions first and rounding only
  -- the total is both simpler and strictly more accurate; there is no correctness reason found to
  -- prefer per-segment rounding here.
  with segs as (
    select * from public.subscription_billing_period_segments(p_subscription_id, p_period_start, p_period_end)
  ),
  totals as (
    select
      (p_period_end - p_period_start)::numeric as total_days,
      coalesce(sum(case when is_billable then monthly_price_ils * segment_days else 0 end), 0) as weighted_sum,
      count(*) as seg_count,
      coalesce(bool_and(is_billable), false) as all_billable
    from segs
  )
  select
    round(case when total_days > 0 then weighted_sum / total_days else 0 end, 2) as amount_ils,
    (seg_count = 1 and all_billable) as is_full_recurring
  from totals;
$$;

comment on function public.subscription_billing_period_amount(uuid, date, date) is
  'Sums subscription_billing_period_segments into one final amount for the period (rounded once, '
  'at the end — see inline comment) and reports whether it is a single, fully-billable segment '
  '(the "recurring, full price" case) or not (proration, whether organic or from a correction).';

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
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_amount record;
  v_new_amount numeric(12, 2);
  v_new_type public.subscription_charge_type;
  v_existing public.subscription_charges%rowtype;
begin
  -- p_version_id is validated for existence/ownership and stored on the billing_periods row for
  -- audit purposes only ("the version current when this call was made") — it is NEVER used for
  -- pricing (see the schema-comment update below on subscription_billing_periods.version_id for
  -- the full rationale). All pricing/eligibility comes exclusively from
  -- subscription_billing_period_amount, which independently walks the subscription's real
  -- version/freeze timeline for this exact period.
  if not exists (
    select 1 from public.subscription_versions where id = p_version_id and subscription_id = p_subscription_id
  ) then
    if not exists (select 1 from public.subscription_versions where id = p_version_id) then
      return json_build_object('ok', false, 'error', 'version_not_found');
    end if;
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
  end if;

  -- Keep version_id fresh as "most recently touched by" (informational only — see above) so a
  -- correction call records which version/event prompted the most recent look at this period.
  update public.subscription_billing_periods
  set version_id = p_version_id
  where id = v_bp_id and version_id is distinct from p_version_id;

  select * into v_amount
  from public.subscription_billing_period_amount(p_subscription_id, p_period_start, p_period_end);
  v_new_amount := v_amount.amount_ils;

  -- Find the CURRENTLY EFFECTIVE charge for this period — not "the original" — so a second (or
  -- Nth) correction reverses whatever is actually in effect right now, not the first-ever charge.
  -- Bug found and fixed during the pre-merge financial audit: the original version of this query
  -- was `WHERE charge_type IN ('recurring','proration')`, which always finds the very first
  -- charge, forever — a second correction to the same period (e.g. a freeze correcting ₪300 to
  -- ₪250, then a further change correcting to ₪180) would reverse the ORIGINAL ₪300 a second
  -- time instead of the ₪250 that was actually in effect, silently producing the wrong net total
  -- (130 instead of 180 in that example). The "currently effective" charge is defined as: the one
  -- non-reversal charge for this period that no reversal row points at yet (every correction
  -- reverses exactly the charge that preceded it, forming a chain; exactly one un-reversed link
  -- exists at any time). Ties are impossible by construction (each correction call produces at
  -- most one such charge), but charge_type<>'reversal' plus the "not yet reversed" condition is
  -- kept explicit rather than relying on insertion order/timestamps, which can coincide within a
  -- single transaction (created_at defaults to now(), constant per transaction). This still holds
  -- unchanged under the new multi-version segmentation: it operates purely on the charges ledger,
  -- independent of how v_new_amount was computed.
  select c.* into v_existing
  from public.subscription_charges c
  where c.billing_period_id = v_bp_id
    and c.charge_type <> 'reversal'
    and not exists (
      select 1 from public.subscription_charges rv
      where rv.charge_type = 'reversal' and rv.reverses = c.id
    )
  order by c.created_at desc, c.id desc
  limit 1;

  if not found then
    -- No charge exists yet for this period at all. This is either a brand-new period (typical
    -- case) OR a period row that was already inserted by a PRIOR run that crashed/died before
    -- reaching this point (found via the pre-merge audit: the original code used
    -- v_created_period — "did *this* call insert the period row" — to decide 'recurring'/
    -- 'proration' vs a caller-supplied correction type, which is wrong here: a crashed prior run
    -- leaves v_created_period=false on THIS call even though no charge was ever written, so the
    -- old logic would try to insert with charge_type = p_correction_charge_type, which is NULL
    -- for the daily job's fresh-generation calls — a NOT NULL constraint violation that would
    -- permanently strand the period as "row exists, still uncharged" since the daily job's next
    -- run also finds the period row and stops walking forward past it without ever completing
    -- the charge). Using "no charge found" (not "did I just create the row") correctly recovers
    -- in both cases and always produces the right organic type.
    v_new_type := case when v_amount.is_full_recurring
                        then 'recurring'::public.subscription_charge_type
                        else 'proration'::public.subscription_charge_type
                   end;
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
  'must also pass p_correction_charge_type (freeze_credit / stop_proration). p_version_id is '
  'validated and stored on the row for audit purposes only — pricing always comes from '
  'subscription_billing_period_amount, which independently segments the period across every '
  'version/freeze that actually applies, never from this one parameter.';

-- Post-audit revision of subscription_billing_periods.version_id's meaning (defined in Phase 1,
-- supabase/migrations/20260924100000_subscriptions_schema.sql — updating its documentation here
-- rather than altering that migration, since nothing anywhere reads this column for pricing:
-- confirmed by inspection that Phase 1's other helpers, Phase 2's registration/coverage logic,
-- and _period_merged_athlete_finance's subscription_charges union arm never join to or select
-- subscription_billing_periods.version_id at all). Left NOT NULL / FK-enforced (kept safe and
-- simple — no ALTER TABLE needed) but its meaning is now purely informational: "the version that
-- was current at generation time, or most recently touched this period via a correction call" —
-- it is NEVER read for pricing/eligibility math anywhere. The authoritative price for a period is
-- always recomputed on demand from subscription_billing_period_amount / _segments against the
-- live subscription_versions/subscription_freezes timeline — never cached, never inferred from
-- this column, so it can never drift out of sync with the real timeline.
comment on column public.subscription_billing_periods.version_id is
  'Informational only: the subscription_versions row current at generation time, or most recently '
  'touched by a correction call. NEVER used for pricing — a period can span multiple versions; the '
  'authoritative amount always comes from subscription_billing_period_amount, recomputed on demand '
  'from the live version/freeze timeline, not read from or cached via this column.';

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
  v_failed int := 0;
  v_res json;
  v_stranded_id uuid;
  v_stranded_version uuid;
  v_stranded_start date;
  v_stranded_end date;
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
    -- Isolate each subscription: this is otherwise one single transaction for the whole job
    -- (a plain PL/pgSQL loop has no per-iteration commit), so without this block, one bad
    -- subscription raising an uncaught exception would abort every other subscription's work in
    -- the same run too. A BEGIN/EXCEPTION block gives per-iteration savepoint semantics — an
    -- exception here rolls back only this subscription's partial writes and lets the loop
    -- continue; it does not give independent atomic commits per subscription (that would require
    -- a real separate transaction per subscription, which a single SQL function body cannot do).
    begin
      loop
        -- Crash-recovery, found and fixed during the pre-merge financial audit: the "find the
        -- next period to generate" logic below always advanced PAST the most recent existing
        -- subscription_billing_periods row, on the assumption that a period row existing at all
        -- means it was fully completed (row + charge) together. That assumption breaks if a prior
        -- run died between the period INSERT and the charge INSERT (a real, if rare, crash
        -- window) — the period row would be silently skipped forever, permanently stranding it
        -- as "processed but uncharged". Before walking forward, always check for and complete any
        -- existing period for this subscription that has no original (recurring/proration)
        -- charge yet, using that period's own recorded period_start/period_end/version_id, then
        -- loop back — this recovers any number of stranded periods (even from repeated crashes)
        -- before resuming the normal forward walk.
        select bp.id, bp.version_id, bp.period_start, bp.period_end
        into v_stranded_id, v_stranded_version, v_stranded_start, v_stranded_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
          and not exists (
            select 1 from public.subscription_charges c
            where c.billing_period_id = bp.id and c.charge_type in ('recurring', 'proration')
          )
        order by bp.period_start asc
        limit 1;

        if v_stranded_id is not null then
          v_res := public.subscription_generate_or_correct_billing_period(
            r.subscription_id, v_stranded_version, v_stranded_start, v_stranded_end, null, null
          );
          if coalesce((v_res->>'ok')::boolean, false) then
            v_periods_touched := v_periods_touched + 1;
          end if;
          continue;
        end if;

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
    exception
      when others then
        v_failed := v_failed + 1;
    end;
  end loop;

  return json_build_object('ok', true, 'periods_touched', v_periods_touched, 'subscriptions_failed', v_failed);
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
