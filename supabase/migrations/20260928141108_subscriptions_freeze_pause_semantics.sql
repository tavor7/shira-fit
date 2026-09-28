-- Subscription Management — freeze semantics correction.
--
-- PRODUCT RULE CORRECTION, not a new feature. The original Phase 3 billing engine modeled a freeze
-- as a prorated discount WITHIN the existing calendar period, leaving the billing anchor and plan
-- end date untouched (subscription_billing_period_segments marked a frozen segment "not billable"
-- but never moved the period's own start/end; generate_due_subscription_charges always stepped
-- forward via subscription_next_anchor_date from the pure calendar anchor, with no awareness of
-- freezes at all; weekly allowance was never reduced for a partially-frozen week). That is a
-- "billing interruption" model. The correct model is a true PAUSE: a freeze pushes the entire
-- future billing schedule (and, when set, the plan end date) forward by exactly its own duration,
-- cumulatively across every freeze ever applied, and reduces a partially-frozen week's allowance
-- proportionally. See the checkpoint report for the full before/after and verification.
--
-- Read-only production check performed before writing this migration: 0 rows in
-- subscription_freezes, 2 subscriptions / 2 versions / 2 billing_periods / 2 charges (both
-- 'recurring', 0 'freeze_credit'). No real freeze or freeze-affected billing data exists, so this
-- is a clean forward schema/logic correction — no data-transforming compatibility migration is
-- needed. The two existing billing_periods rows are backfilled with raw_period_start/
-- raw_period_end equal to their current (already-correct, since frozen_days=0) period_start/
-- period_end.
--
-- ---------------------------------------------------------------------------
-- Terminology introduced here (see also the comment on each new function):
--   configured weekly limit      = subscription_version_allowances.weekly_limit (unchanged meaning)
--   effective weekly limit       = subscription_effective_weekly_limit(...) -- prorated for a
--                                   specific week's frozen Sun-Fri days
--   raw (period) start/end       = subscription_billing_periods.raw_period_start/raw_period_end --
--                                   the pure calendar-anchor dates, AS IF no freeze ever happened;
--                                   the stable identity of "which billing cycle is this"
--   effective (period) start/end = subscription_billing_periods.period_start/period_end (existing
--                                   columns, meaning UNCHANGED in name but now genuinely shifted) --
--                                   the real calendar dates the period actually spans/is due on
--   configured plan end          = subscription_versions.plan_end_date (unchanged meaning)
--   effective plan end           = subscription_effective_plan_end_date(...) -- configured end
--                                   extended by every applicable freeze day, regardless of whether
--                                   plan_end_date was already set when a given freeze occurred
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. subscription_billing_periods: add the raw/effective distinction.
-- ---------------------------------------------------------------------------

alter table public.subscription_billing_periods
  add column if not exists raw_period_start date,
  add column if not exists raw_period_end date,
  add column if not exists frozen_days_applied int not null default 0;

update public.subscription_billing_periods
set raw_period_start = period_start, raw_period_end = period_end
where raw_period_start is null;

alter table public.subscription_billing_periods
  alter column raw_period_start set not null,
  alter column raw_period_end set not null;

alter table public.subscription_billing_periods
  drop constraint if exists subscription_billing_periods_raw_dates_chk;
alter table public.subscription_billing_periods
  add constraint subscription_billing_periods_raw_dates_chk check (raw_period_end > raw_period_start);

-- raw_period_start is the STABLE identity of a billing cycle (it never changes once a period is
-- generated); period_start (effective) can move forward as cumulative frozen days grow, so it can
-- no longer be the uniqueness key.
alter table public.subscription_billing_periods
  drop constraint if exists subscription_billing_periods_period_uniq;
alter table public.subscription_billing_periods
  add constraint subscription_billing_periods_raw_period_uniq unique (subscription_id, raw_period_start);

comment on column public.subscription_billing_periods.raw_period_start is
  'Pure calendar-anchor start date, as if no freeze had ever been applied to this subscription -- '
  'the stable identity of this billing cycle. Never changes once the row exists. Used only to step '
  'to the NEXT cycle''s raw dates via subscription_next_anchor_date; never used for pricing/display.';
comment on column public.subscription_billing_periods.raw_period_end is
  'Pure calendar-anchor end date paired with raw_period_start. See its comment.';
comment on column public.subscription_billing_periods.frozen_days_applied is
  'Cumulative frozen days added to raw_period_start/raw_period_end to produce the effective '
  'period_start/period_end, as of the last time this row was generated or corrected. Recorded for '
  'auditability; the authoritative source is always subscription_total_frozen_days(), recomputed '
  'fresh on every generate/correct call, never trusted from a stale copy on this row.';
comment on column public.subscription_billing_periods.period_start is
  'EFFECTIVE (real calendar) start date this period is actually due/spans -- raw_period_start plus '
  'every applicable frozen day. This is what the daily job compares against "today", and what a '
  'manager/athlete should be shown.';
comment on column public.subscription_billing_periods.period_end is
  'EFFECTIVE (real calendar) end date. See period_start''s comment.';

-- ---------------------------------------------------------------------------
-- 2. subscription_total_frozen_days -- the single source of "how many calendar days has this
--    subscription's clock been paused for", cumulative across every non-cancelled freeze.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_total_frozen_days(
  p_subscription_id uuid,
  p_as_of date default null
)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum((f.freeze_until - f.freeze_from + 1)), 0)::int
  from public.subscription_freezes f
  where f.subscription_id = p_subscription_id
    and f.cancelled_at is null
    and (p_as_of is null or f.freeze_from <= p_as_of);
$$;

comment on function public.subscription_total_frozen_days(uuid, date) is
  'Cumulative frozen calendar days for this subscription (each freeze counts its FULL inclusive '
  'duration, freeze_until - freeze_from + 1, once freeze_from has occurred on/before p_as_of). '
  'p_as_of NULL = every freeze ever applied, regardless of timing. This is the one authoritative '
  'pause-duration figure every billing-shift/plan-end/allowance calculation below is built from -- '
  'never re-derived or duplicated elsewhere. Deliberately independent of plan_end_date being set at '
  'the time a freeze occurred, so freeze history is never lost merely because a subscription had no '
  'end date yet when it was frozen (see subscription_effective_plan_end_date).';

-- No grant: internal helper only, matching subscription_effective_context''s convention -- it takes
-- an arbitrary subscription_id with no caller-identity check, so it is only ever called from other
-- SECURITY DEFINER functions in this codebase.

-- ---------------------------------------------------------------------------
-- 3. subscription_effective_plan_end_date -- configured plan end, extended by every applicable
--    frozen day. NULL stays NULL (no end date to extend; the pause is still tracked via
--    subscription_total_frozen_days for if/when an end date is later set -- see edit_subscription_
--    version, unchanged, which always copies the CURRENT plan_end_date/has_no_end_date forward; no
--    special-casing is needed there because this function re-derives from live freeze rows, not
--    from a cached shift captured at some earlier point in time).
-- ---------------------------------------------------------------------------

create or replace function public.subscription_effective_plan_end_date(p_version_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select case
    when v.plan_end_date is null then null
    else v.plan_end_date + public.subscription_total_frozen_days(v.subscription_id, v.plan_end_date)
  end
  from public.subscription_versions v
  where v.id = p_version_id;
$$;

comment on function public.subscription_effective_plan_end_date(uuid) is
  'The plan end date the athlete actually loses, extended by every freeze day applicable on/before '
  'it (subscription_total_frozen_days), regardless of when those freezes occurred relative to '
  'plan_end_date being set -- an athlete never loses paid subscription lifetime to a freeze. NULL '
  'when the version has no end date (nothing to extend; frozen days are still tracked via '
  'subscription_total_frozen_days and will apply automatically if an end date is added later).';

grant execute on function public.subscription_effective_plan_end_date(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. subscription_effective_next_billing_date -- the real (shifted) date of the next charge.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_effective_next_billing_date(p_subscription_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_latest_end date;
  v_version public.subscription_versions%rowtype;
  v_raw_end date;
begin
  select bp.period_end into v_latest_end
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_subscription_id
  order by bp.raw_period_start desc
  limit 1;

  if v_latest_end is not null then
    return v_latest_end;
  end if;

  -- No billing period generated yet (e.g. plan_start_date is still in the future, or the daily job
  -- simply hasn't run yet today): compute the hypothetical first period's effective end the exact
  -- same way subscription_generate_or_correct_billing_period will, when it eventually runs.
  select * into v_version from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return null;
  end if;

  v_raw_end := public.subscription_next_anchor_date(v_version.anchor_day, v_version.plan_start_date);
  return v_raw_end + public.subscription_total_frozen_days(p_subscription_id, v_raw_end);
end;
$$;

comment on function public.subscription_effective_next_billing_date(uuid) is
  'The real calendar date of the next (or currently in-progress) billing period''s charge, already '
  'reflecting every applicable freeze shift. Reads the latest subscription_billing_periods row''s '
  'effective period_end when one exists; otherwise computes the hypothetical first period the same '
  'way generation will, so a not-yet-billed subscription still shows a correct shifted date.';

grant execute on function public.subscription_effective_next_billing_date(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. subscription_effective_weekly_limit -- weekly-allowance proration for a partially-frozen week.
--
-- effective_weekly_limit = CEIL(configured_weekly_limit * eligible_non_saturday_days / 6), where
-- eligible_non_saturday_days is the count of Sun-Fri dates in the week that are in the
-- subscription's eligible window (subscription_effective_context.in_window) AND not frozen.
-- Saturday is excluded from the denominator only -- never from eligibility itself; a Saturday
-- registration still authoritatively counts against whatever this returns (that decision is made
-- by the existing subscription_registration_coverage counting logic, unchanged, which counts
-- registrations across all 7 days of the week against this one weekly total).
-- ---------------------------------------------------------------------------

create or replace function public.subscription_effective_weekly_limit(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_tier public.subscription_tier,
  p_week_start date
)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_eligible_days int := 0;
  v_configured int := 0;
  v_ctx public.subscription_effective_context_result;
  d date;
begin
  for d in select generate_series(p_week_start, p_week_start + 5, interval '1 day')::date loop
    v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, d, p_tier);
    if v_ctx.in_window and not v_ctx.is_frozen then
      v_eligible_days := v_eligible_days + 1;
      v_configured := coalesce(v_ctx.weekly_limit, 0);
    end if;
  end loop;

  if v_eligible_days = 0 or v_configured <= 0 then
    return 0;
  end if;

  return ceil(v_configured * v_eligible_days / 6.0)::int;
end;
$$;

comment on function public.subscription_effective_weekly_limit(uuid, boolean, public.subscription_tier, date) is
  'Prorated weekly allowance for one payee/tier/week: CEIL(configured_weekly_limit * '
  'eligible_non_saturday_days / 6). eligible_non_saturday_days walks Sunday-Friday (Saturday '
  'deliberately excluded from the denominator only -- the studio''s standard usable week) and '
  'counts a day only when subscription_effective_context reports it in-window and not frozen for '
  'that exact date, reusing the single authoritative eligibility check rather than duplicating '
  'window/freeze logic. Returns 0 if every eligible day is frozen/out-of-window, or if the tier is '
  'not configured at all (distinct from "tier_not_included" as a non_coverage_reason, which callers '
  'still derive from the CONFIGURED weekly_limit, never from this prorated figure).';

-- No grant: same rationale as subscription_effective_context (arbitrary payee_id/payee_is_manual,
-- no identity check) -- only ever called from other SECURITY DEFINER functions.

-- ---------------------------------------------------------------------------
-- 6. subscription_billing_period_segments / subscription_billing_period_amount -- frozen segments
--    now excluded from BOTH sides of the proration ratio (not just the numerator), so a freeze
--    inside an otherwise-normal period nets to the SAME amount as an unfrozen period once its
--    period_end has been extended by the freeze duration (see subscription_generate_or_correct_
--    billing_period below) -- "pause", not "discount". A genuinely partial period for an unrelated
--    reason (subscription start mid-cycle, a version price change, a stop) still prorates exactly
--    as before; the freeze exclusion is simply layered on top, unchanged for every other case.
-- ---------------------------------------------------------------------------

-- Adding is_frozen changes the OUT-parameter row type; CREATE OR REPLACE cannot alter that shape.
drop function if exists public.subscription_billing_period_segments(uuid, date, date);

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
  is_frozen boolean,
  segment_days int
)
language sql
stable
security definer
set search_path = public
as $$
  with boundary_points as (
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
    exists (
      select 1 from public.subscription_freezes f
      where f.subscription_id = p_subscription_id and f.cancelled_at is null
        and f.freeze_from <= s.segment_start and f.freeze_until >= s.segment_start
    ) as is_frozen,
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
  'inside the period. Adds is_frozen alongside the existing is_billable: a frozen segment is always '
  'is_billable=false AND is_frozen=true, and subscription_billing_period_amount excludes is_frozen '
  'segments from its denominator entirely (pause), not just its numerator (the old, incorrect '
  '"discount within a fixed period" behavior).';

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
  with segs as (
    select * from public.subscription_billing_period_segments(p_subscription_id, p_period_start, p_period_end)
  ),
  totals as (
    select
      coalesce(sum(segment_days) filter (where not is_frozen), 0)::numeric as total_days,
      coalesce(sum(case when is_billable then monthly_price_ils * segment_days else 0 end), 0) as weighted_sum,
      count(*) filter (where not is_frozen) as seg_count,
      coalesce(bool_and(is_billable) filter (where not is_frozen), false) as all_billable
    from segs
  )
  select
    round(case when total_days > 0 then weighted_sum / total_days else 0 end, 2) as amount_ils,
    (seg_count = 1 and all_billable) as is_full_recurring
  from totals;
$$;

comment on function public.subscription_billing_period_amount(uuid, date, date) is
  'Sums subscription_billing_period_segments into one final amount, now dividing by total NON-'
  'FROZEN days only (frozen days count toward neither the numerator nor the denominator -- they '
  'are outside the subscription''s billable time entirely, matching the pause model). Combined with '
  'subscription_generate_or_correct_billing_period extending period_end by the freeze duration, a '
  'freeze inside an otherwise-normal period reprices to the exact same full amount as an unfrozen '
  'period -- a pause costs nothing extra and refunds nothing, it simply moves time.';

-- ---------------------------------------------------------------------------
-- 7. subscription_generate_or_correct_billing_period -- now takes RAW (unshifted) period bounds
--    and computes/persists the effective (shifted) bounds internally. Existing positional callers
--    (tests, the daily job, freeze/stop RPCs) are unaffected in the common no-freeze case, since
--    effective == raw whenever subscription_total_frozen_days() is 0.
-- ---------------------------------------------------------------------------

-- Parameter names changed (p_period_start/p_period_end -> p_raw_period_start/p_raw_period_end);
-- CREATE OR REPLACE cannot rename parameters.
drop function if exists public.subscription_generate_or_correct_billing_period(
  uuid, uuid, date, date, uuid, public.subscription_charge_type
);

create or replace function public.subscription_generate_or_correct_billing_period(
  p_subscription_id uuid,
  p_version_id uuid,
  p_raw_period_start date,
  p_raw_period_end date,
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
  v_frozen_days int;
  v_period_start date;
  v_period_end date;
  v_amount record;
  v_new_amount numeric(12, 2);
  v_new_type public.subscription_charge_type;
  v_existing public.subscription_charges%rowtype;
begin
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

  v_frozen_days := public.subscription_total_frozen_days(p_subscription_id, p_raw_period_end);
  v_period_start := p_raw_period_start + v_frozen_days;
  v_period_end := p_raw_period_end + v_frozen_days;

  insert into public.subscription_billing_periods (
    subscription_id, version_id, period_start, period_end,
    raw_period_start, raw_period_end, frozen_days_applied
  )
  values (
    p_subscription_id, p_version_id, v_period_start, v_period_end,
    p_raw_period_start, p_raw_period_end, v_frozen_days
  )
  on conflict (subscription_id, raw_period_start) do nothing
  returning id into v_bp_id;

  if v_bp_id is null then
    select id into v_bp_id
    from public.subscription_billing_periods
    where subscription_id = p_subscription_id and raw_period_start = p_raw_period_start;
  end if;

  -- Keep the row's version_id, and its effective dates/frozen_days_applied, current -- a freeze
  -- created after this period already existed must immediately shift it (period_start/period_end
  -- are scheduling metadata, safe to update in place; the financial ledger rows are the only thing
  -- this function ever treats as immutable-except-via-reversal).
  update public.subscription_billing_periods
  set version_id = p_version_id,
      period_start = v_period_start,
      period_end = v_period_end,
      frozen_days_applied = v_frozen_days
  where id = v_bp_id
    and (
      version_id is distinct from p_version_id
      or period_start is distinct from v_period_start
      or period_end is distinct from v_period_end
      or frozen_days_applied is distinct from v_frozen_days
    );

  select * into v_amount
  from public.subscription_billing_period_amount(p_subscription_id, v_period_start, v_period_end);
  v_new_amount := v_amount.amount_ils;

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
      'amount_ils', v_new_amount, 'charge_type', v_new_type,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

  if v_existing.amount_ils = v_new_amount then
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'unchanged', 'amount_ils', v_existing.amount_ils,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

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
    'reversed_ils', v_existing.amount_ils,
    'period_start', v_period_start, 'period_end', v_period_end
  );
exception
  when unique_violation then
    return json_build_object('ok', true, 'action', 'concurrent_noop');
end;
$$;

comment on function public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type) is
  'p_raw_period_start/p_raw_period_end are the PURE calendar-anchor bounds (never shifted by the '
  'caller) -- this function is the one place that adds subscription_total_frozen_days to produce '
  'the real/effective period_start/period_end, writes both onto the row, and reprices from the '
  'effective bounds. Idempotent and safe to re-run any number of times for the same raw period: the '
  'unique key is (subscription_id, raw_period_start), so a freeze created after this row already '
  'exists updates the SAME row (new effective dates, re-priced), it never creates a duplicate. '
  'p_source_event_id/p_correction_charge_type unchanged from before -- still only consulted when '
  'the recomputed amount actually differs from what is currently charged.';

-- ---------------------------------------------------------------------------
-- 8. generate_due_subscription_charges -- steps forward in RAW time (so month-length arithmetic
--    stays exactly as before, untouched), and treats a period as "due" once its EFFECTIVE
--    (shifted) start has arrived, not its raw one.
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
  v_last_raw_start date;
  v_next_raw_start date;
  v_next_raw_end date;
  v_effective_start date;
  v_effective_plan_end date;
  v_periods_touched int := 0;
  v_failed int := 0;
  v_res json;
  v_stranded_id uuid;
  v_stranded_version uuid;
  v_stranded_raw_start date;
  v_stranded_raw_end date;
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
    begin
      v_effective_plan_end := public.subscription_effective_plan_end_date(r.version_id);
      loop
        select bp.id, bp.version_id, bp.raw_period_start, bp.raw_period_end
        into v_stranded_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
          and not exists (
            select 1 from public.subscription_charges c
            where c.billing_period_id = bp.id and c.charge_type in ('recurring', 'proration')
          )
        order by bp.raw_period_start asc
        limit 1;

        if v_stranded_id is not null then
          v_res := public.subscription_generate_or_correct_billing_period(
            r.subscription_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end, null, null
          );
          if coalesce((v_res->>'ok')::boolean, false) then
            v_periods_touched := v_periods_touched + 1;
          end if;
          continue;
        end if;

        select bp.raw_period_start into v_last_raw_start
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
        order by bp.raw_period_start desc
        limit 1;

        if v_last_raw_start is null then
          v_next_raw_start := r.plan_start_date;
        else
          v_next_raw_start := public.subscription_next_anchor_date(r.anchor_day, v_last_raw_start);
        end if;

        v_next_raw_end := public.subscription_next_anchor_date(r.anchor_day, v_next_raw_start);
        v_effective_start := v_next_raw_start + public.subscription_total_frozen_days(r.subscription_id, v_next_raw_end);

        exit when v_effective_start > v_today;
        exit when r.stopped_effective_date is not null and v_effective_start >= r.stopped_effective_date;
        exit when v_effective_plan_end is not null and v_effective_start > v_effective_plan_end;

        v_res := public.subscription_generate_or_correct_billing_period(
          r.subscription_id, r.version_id, v_next_raw_start, v_next_raw_end, null, null
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
  'Daily billing job. Steps forward using RAW anchor dates only (subscription_next_anchor_date is '
  'completely freeze-unaware, so month-length/February/leap-year arithmetic is exactly as before); '
  'a period becomes due once its EFFECTIVE (freeze-shifted) start has arrived, and the stop/plan-end '
  'cutoffs are likewise compared against effective dates (subscription_effective_plan_end_date), so '
  'a freeze correctly delays both when the next charge lands and when billing stops for an '
  'end-dated or stopped plan. Idempotent -- safe to run twice or concurrently for the same period.';

revoke all on function public.generate_due_subscription_charges() from public;
grant execute on function public.generate_due_subscription_charges() to service_role;
grant execute on function public.generate_due_subscription_charges() to postgres;

-- ---------------------------------------------------------------------------
-- 9. subscription_reserve_or_reject / subscription_reconcile_week -- allowance comparisons now use
--    the EFFECTIVE (prorated) weekly limit; "tier_not_included" still checks the CONFIGURED limit
--    (a tier either is or isn't part of the plan at all -- that fact is never affected by a
--    freeze, so it must stay a distinct reason from "allowance_exceeded").
-- ---------------------------------------------------------------------------

create or replace function public.subscription_reserve_or_reject(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_session_id uuid,
  p_accept_extra boolean default false
)
returns public.subscription_reserve_decision
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess public.training_sessions%rowtype;
  v_tier public.subscription_tier;
  v_week_start date;
  v_ctx public.subscription_effective_context_result;
  v_lock_key bigint;
  v_covered_count int;
  v_effective_limit int;
  v_result public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    raise exception 'session_not_found';
  end if;

  v_tier := public.subscription_tier_for_capacity(v_sess.max_participants);
  v_week_start := v_sess.session_date - extract(dow from v_sess.session_date)::int;

  v_lock_key := public.subscription_lock_key(p_payee_id, p_payee_is_manual, v_week_start, v_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, v_sess.session_date, v_tier);

  v_result.tier := v_tier;
  v_result.week_start := v_week_start;

  if v_ctx.subscription_id is null or not v_ctx.in_window then
    v_result.outcome := 'not_subscribed';
    v_result.ok := true;
    v_result.subscription_id := null;
    v_result.version_id := null;
    v_result.covered := null;
    v_result.non_coverage_reason := null;
    return v_result;
  end if;

  v_result.subscription_id := v_ctx.subscription_id;
  v_result.version_id := v_ctx.version_id;

  if v_ctx.is_frozen then
    -- Session-date freeze eligibility is unchanged: a session ON a frozen date is never covered,
    -- regardless of the week's effective allowance.
    v_result.outcome := 'frozen';
    v_result.non_coverage_reason := 'frozen';
  elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
    v_result.outcome := 'tier_not_included';
    v_result.non_coverage_reason := 'tier_not_included';
  else
    v_effective_limit := public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, v_tier, v_week_start);

    select count(*) into v_covered_count
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    where cov.subscription_id = v_ctx.subscription_id
      and cov.tier = v_tier
      and cov.week_start = v_week_start
      and cov.covered = true
      and (
        cov.manual_participant_id is not null
        or reg.status = 'active'
        or exists (
          select 1 from public.cancellations c
          where c.session_id = reg.session_id
            and c.user_id = reg.user_id
            and c.charged_full_price is true
        )
      );

    if v_covered_count < v_effective_limit then
      v_result.outcome := 'covered';
      v_result.non_coverage_reason := null;
    else
      v_result.outcome := 'allowance_exceeded';
      v_result.non_coverage_reason := 'allowance_exceeded';
    end if;
  end if;

  if v_result.outcome = 'covered' then
    v_result.covered := true;
    v_result.ok := true;
  else
    v_result.covered := false;
    v_result.ok := coalesce(p_accept_extra, false);
  end if;

  return v_result;
end;
$$;

comment on function public.subscription_reserve_or_reject(uuid, boolean, uuid, boolean) is
  'Atomic per-registration subscription entitlement decision. Now compares against '
  'subscription_effective_weekly_limit (prorated for this week''s frozen Sun-Fri days), not the raw '
  'configured weekly_limit -- "tier_not_included" still checks the configured limit directly, since '
  'that fact (this tier is/isn''t part of the plan) is never affected by a freeze. On ok=false, '
  'callers must return a structured subscription_limit_exceeded error and insert nothing.';

create or replace function public.subscription_reconcile_week(
  p_subscription_id uuid,
  p_week_start date,
  p_tier public.subscription_tier
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_lock_key bigint;
  v_covered_count int := 0;
  v_effective_limit int;
  v_ctx public.subscription_effective_context_result;
  v_covered boolean;
  v_reason public.subscription_non_coverage_reason;
  r record;
begin
  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return;
  end if;

  v_lock_key := public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  v_effective_limit := public.subscription_effective_weekly_limit(v_payee_id, v_payee_is_manual, p_tier, p_week_start);

  if not v_payee_is_manual then
    for r in
      select reg.id as registration_id, reg.registered_at as created_at, s.session_date
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where reg.user_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          (reg.status = 'active' and reg.attended is true)
          or (reg.status = 'active' and reg.attended is false and reg.charge_no_show is true)
          or exists (
            select 1 from public.cancellations c
            where c.session_id = reg.session_id
              and c.user_id = reg.user_id
              and c.charged_full_price is true
          )
        )
      order by reg.registered_at asc, reg.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_effective_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  else
    for r in
      select m.id as registration_id, m.added_at as created_at, s.session_date
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where m.manual_participant_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          (m.attended is true)
          or (m.attended is false and m.charge_no_show is true)
        )
      order by m.added_at asc, m.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_effective_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, null, r.registration_id,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  end if;
end;
$$;

comment on function public.subscription_reconcile_week(uuid, date, public.subscription_tier) is
  'Pure, idempotent recompute of coverage for one subscription/week/tier, ordered by '
  'registration.registered_at ASC, id ASC. Now compares against subscription_effective_weekly_limit '
  '(computed once per call, since it depends only on payee/tier/week_start, not on any individual '
  'registration) instead of the raw configured weekly_limit -- a partial-week freeze can flip '
  'already-covered registrations back to allowance_exceeded here, exactly like a manager lowering '
  'the configured limit already did before this change. Safe to call twice.';

-- ---------------------------------------------------------------------------
-- 10. subscription_compute_impact -- freeze preview now also reports the derived
--     next-billing/effective-plan-end dates the freeze WOULD produce, computed by actually running
--     the real billing-period correction inside the same rolled-back preview transaction (so the
--     manager UI never has to compute a shifted date itself).
-- ---------------------------------------------------------------------------

create or replace function public.subscription_compute_impact(
  p_subscription_id uuid,
  p_action_type public.subscription_impact_action_type,
  p_freeze_from date default null,
  p_freeze_until date default null,
  p_stop_date date default null,
  p_new_effective_from date default null,
  p_new_price numeric default null,
  p_new_plan_end_date date default null,
  p_clear_end_date boolean default false,
  p_new_allowances jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_current public.subscription_versions%rowtype;
  v_new_version_id uuid;
  v_freeze_id uuid;
  v_range_start date;
  v_items jsonb := '[]'::jsonb;
  v_count int := 0;
  v_has_history boolean;
  v_new_plan_end_date date;
  v_preview_next_billing_date date;
  v_preview_effective_plan_end_date date;
  r record;
  v_after public.subscription_registration_coverage%rowtype;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id and deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if p_action_type = 'freeze' then
    if p_freeze_from is null or p_freeze_until is null then
      return jsonb_build_object('ok', false, 'error', 'freeze_dates_required');
    end if;
    v_range_start := p_freeze_from;
  elsif p_action_type = 'stop' then
    if p_stop_date is null then
      return jsonb_build_object('ok', false, 'error', 'stop_date_required');
    end if;
    v_range_start := p_stop_date;
  elsif p_action_type = 'edit' then
    if p_new_effective_from is null then
      return jsonb_build_object('ok', false, 'error', 'effective_from_required');
    end if;
    v_range_start := p_new_effective_from;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported_action_type');
  end if;

  create temporary table if not exists _subscription_impact_before (
    coverage_id uuid primary key,
    covered boolean not null
  ) on commit drop;
  delete from _subscription_impact_before;

  insert into _subscription_impact_before (coverage_id, covered)
  select id, covered from public.subscription_registration_coverage
  where subscription_id = p_subscription_id;

  begin
    if p_action_type = 'freeze' then
      insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
      values (p_subscription_id, p_freeze_from, p_freeze_until)
      returning id into v_freeze_id;

    elsif p_action_type = 'stop' then
      update public.subscription_versions
      set stopped_effective_date = p_stop_date
      where id = v_current.id;

    elsif p_action_type = 'edit' then
      v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

      if p_new_effective_from < v_current.effective_from then
        return jsonb_build_object('ok', false, 'error', 'effective_from_before_current_version');
      end if;

      if p_new_effective_from = v_current.effective_from then
        select exists (
          select 1 from public.subscription_billing_periods where version_id = v_current.id
          union all
          select 1 from public.subscription_registration_coverage where version_id = v_current.id
        ) into v_has_history;

        if not v_has_history then
          update public.subscription_versions
          set monthly_price_ils = coalesce(p_new_price, v_current.monthly_price_ils),
              plan_end_date = v_new_plan_end_date
          where id = v_current.id;
          v_new_version_id := v_current.id;

          if p_new_allowances is not null then
            delete from public.subscription_version_allowances where version_id = v_current.id;
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_current.id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          end if;
        else
          update public.subscription_versions
          set effective_to = p_new_effective_from
          where id = v_current.id;

          insert into public.subscription_versions (
            subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
            plan_start_date, plan_end_date, created_by
          ) values (
            p_subscription_id,
            (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
            p_new_effective_from,
            coalesce(p_new_price, v_current.monthly_price_ils),
            v_current.anchor_day,
            v_current.plan_start_date,
            v_new_plan_end_date,
            v_current.created_by
          ) returning id into v_new_version_id;

          update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

          if p_new_allowances is not null then
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          else
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, tier, weekly_limit
            from public.subscription_version_allowances where version_id = v_current.id;
          end if;
        end if;
      else
        update public.subscription_versions
        set effective_to = p_new_effective_from
        where id = v_current.id;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_new_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_current.created_by
        ) returning id into v_new_version_id;

        update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

        if p_new_allowances is not null then
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        else
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, tier, weekly_limit
          from public.subscription_version_allowances where version_id = v_current.id;
        end if;
      end if;
    end if;

    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (v_range_start - extract(dow from v_range_start)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    if p_action_type = 'freeze' then
      -- Actually run the real billing-period correction inside this rolled-back block, so the
      -- preview's derived dates come from the exact same authoritative logic the real freeze will
      -- use -- never computed independently here.
      for r in
        select bp.raw_period_start, bp.raw_period_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = p_subscription_id
          and bp.raw_period_end >= p_freeze_from
      loop
        perform public.subscription_generate_or_correct_billing_period(
          p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_freeze_id, 'freeze_credit'
        );
      end loop;

      v_preview_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
      v_preview_effective_plan_end_date := public.subscription_effective_plan_end_date(v_current.id);
    end if;

    for v_after in
      select cov.*
      from public.subscription_registration_coverage cov
      join _subscription_impact_before b on b.coverage_id = cov.id
      where cov.subscription_id = p_subscription_id
        and b.covered = true
        and cov.covered = false
    loop
      v_count := v_count + 1;
      v_items := v_items || jsonb_build_object(
        'registration_id', v_after.registration_id,
        'manual_participant_id', v_after.manual_participant_id,
        'session_date', v_after.session_date,
        'week_start', v_after.week_start,
        'tier', v_after.tier,
        'new_non_coverage_reason', v_after.non_coverage_reason
      );
    end loop;

    raise exception using errcode = 'ZZ001', message = 'subscription_impact_preview_rollback';
  exception
    when sqlstate 'ZZ001' then
      null;
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'items', v_items,
    'current_monthly_price_ils', v_current.monthly_price_ils,
    'preview_next_billing_date', v_preview_next_billing_date,
    'preview_effective_plan_end_date', v_preview_effective_plan_end_date,
    'estimate_note',
      'count is exact (recomputed via the real subscription_reconcile_week algorithm under the ' ||
      'hypothetical state, then rolled back). A precise dollar figure is intentionally not ' ||
      'estimated here — the exact amount is determined by subscription_generate_or_correct_' ||
      'billing_period at confirm time, which segments real calendar days across real prices. For a ' ||
      'freeze specifically, preview_next_billing_date/preview_effective_plan_end_date are computed '||
      'by actually running that same correction logic inside this rolled-back preview.'
  );
end;
$$;

comment on function public.subscription_compute_impact(
  uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb
) is
  'Shared, reusable, side-effect-free impact-preview engine for freeze/stop/edit. For freeze, also '
  'runs the real billing-period correction (raw-bounds based) inside the rolled-back block so '
  'preview_next_billing_date/preview_effective_plan_end_date reflect authoritative backend logic, '
  'not a frontend/duplicate calculation. Always rolls back via a sentinel exception.';

-- ---------------------------------------------------------------------------
-- 11. freeze_subscription -- corrects every billing period whose RAW window is at/after the
--     freeze (covering both the common "current period" case and a genuinely retroactive freeze
--     touching several already-generated periods), and returns the resulting effective dates.
-- ---------------------------------------------------------------------------

create or replace function public.freeze_subscription(
  p_subscription_id uuid,
  p_freeze_from date,
  p_freeze_until date,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_impact jsonb;
  v_freeze_id uuid;
  v_version_id uuid;
  r record;
  v_source_id uuid;
  v_next_billing_date date;
  v_effective_plan_end_date date;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_freeze_from is null or p_freeze_until is null or p_freeze_until < p_freeze_from then
    return json_build_object('ok', false, 'error', 'invalid_freeze_dates');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  if not exists (select 1 from public.subscriptions where id = p_subscription_id and deleted_at is null) then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select id into v_version_id from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if v_version_id is null then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'freeze', p_freeze_from, p_freeze_until
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|freeze|' || p_freeze_from::text || '|' || p_freeze_until::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'freeze' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  begin
    insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until, created_by)
    values (p_subscription_id, p_freeze_from, p_freeze_until, v_uid)
    returning id into v_freeze_id;
  exception
    when exclusion_violation then
      return json_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_freeze_from - extract(dow from p_freeze_from)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  -- Shift every billing period whose raw (unshifted) window is at or after the freeze -- covers
  -- both the ordinary "current period" case and a retroactive freeze touching several already-
  -- generated periods. Each call is idempotent and only writes a correction charge if the
  -- recomputed amount actually differs (the common case: none, since the extended period nets to
  -- the same full price -- see subscription_billing_period_amount's comment).
  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.raw_period_end >= p_freeze_from
    order by bp.raw_period_start asc
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_version_id, r.raw_period_start, r.raw_period_end, v_source_id, 'freeze_credit'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'freeze', v_source_id, p_freeze_from, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  v_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version_id);

  return json_build_object(
    'ok', true, 'action', 'applied', 'freeze_id', v_freeze_id, 'impact', v_impact,
    'frozen_days', (p_freeze_until - p_freeze_from + 1),
    'next_billing_date', v_next_billing_date,
    'effective_plan_end_date', v_effective_plan_end_date
  );
end;
$$;

comment on function public.freeze_subscription(uuid, date, date, boolean) is
  'Manager-only. Impact-preview/confirm freeze. A freeze PAUSES subscription time: it shifts every '
  'future billing date (and, when set, the plan end date) forward by its own duration, cumulative '
  'with every other freeze on this subscription, and reduces a partially-frozen week''s allowance '
  'proportionally (subscription_effective_weekly_limit) -- it does NOT grant a billing discount '
  'within the original schedule (the old, incorrect behavior). Reuses subscription_freezes_no_'
  'overlap_excl for overlap rejection, subscription_reconcile_week for coverage, and the '
  'segmentation engine (via subscription_generate_or_correct_billing_period, now on raw bounds) for '
  'multi-period billing-schedule correction.';

grant execute on function public.freeze_subscription(uuid, date, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. stop_subscription -- unchanged semantics, only updated to pass RAW bounds into the
--     redesigned correction function (it still filters candidate periods by their EFFECTIVE
--     period_end against the real stop date, which is a genuine calendar-date comparison, not a
--     raw/anchor one).
-- ---------------------------------------------------------------------------

create or replace function public.stop_subscription(
  p_subscription_id uuid,
  p_stop_date date,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  v_impact := public.subscription_compute_impact(p_subscription_id, 'stop', null, null, p_stop_date);
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|stop|' || p_stop_date::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_stop_date - extract(dow from p_stop_date)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end > p_stop_date
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_source_id, 'stop_proration'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object('ok', true, 'action', 'applied', 'impact', v_impact);
end;
$$;

comment on function public.stop_subscription(uuid, date, boolean) is
  'Manager-only. Impact-preview/confirm stop; sets stopped_effective_date on the current version '
  '(never a new version), prorates via the existing correction engine (now on raw bounds) including '
  'retroactive stops after a charge already posted. All historical versions/periods/charges are '
  'untouched.';

grant execute on function public.stop_subscription(uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. list_active_subscriptions -- next_billing_date now genuinely effective (was previously '
--     computed from the raw anchor only); adds effective_plan_end_date alongside the existing
--     (unchanged-meaning) plan_end_date.
-- ---------------------------------------------------------------------------

-- Adding effective_plan_end_date changes the OUT-parameter row type.
drop function if exists public.list_active_subscriptions();

create or replace function public.list_active_subscriptions()
returns table (
  subscription_id uuid,
  payee_id uuid,
  payee_is_manual boolean,
  payee_display_name text,
  version_id uuid,
  display_status text,
  monthly_price_ils numeric,
  anchor_day smallint,
  plan_start_date date,
  plan_end_date date,
  effective_plan_end_date date,
  has_no_end_date boolean,
  next_billing_date date,
  is_frozen boolean,
  current_weekly_limits jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  return query
  select
    s.id,
    s.payee_id,
    s.payee_is_manual,
    coalesce(
      case when not s.payee_is_manual then p.full_name else mp.full_name end,
      '(unknown)'
    ),
    v.id,
    public.subscription_version_display_status(v.id, public._studio_today_date()),
    v.monthly_price_ils,
    v.anchor_day,
    v.plan_start_date,
    v.plan_end_date,
    public.subscription_effective_plan_end_date(v.id),
    v.has_no_end_date,
    public.subscription_effective_next_billing_date(s.id),
    exists (
      select 1 from public.subscription_freezes f
      where f.subscription_id = s.id and f.cancelled_at is null
        and public._studio_today_date() between f.freeze_from and f.freeze_until
    ),
    coalesce((
      select jsonb_object_agg(a.tier::text, a.weekly_limit)
      from public.subscription_version_allowances a
      where a.version_id = v.id
    ), '{}'::jsonb)
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) not in ('stopped', 'completed')
  order by s.created_at desc;
end;
$$;

comment on function public.list_active_subscriptions() is
  'Manager-only. Every non-tombstoned subscription whose current version is not stopped/completed '
  'as of today. next_billing_date and effective_plan_end_date now reflect cumulative freeze shift; '
  'plan_end_date keeps its original (configured) meaning. Returns nothing for a non-manager.';

grant execute on function public.list_active_subscriptions() to authenticated;

-- ---------------------------------------------------------------------------
-- 14. get_subscription_detail -- adds effective_plan_end_date per version and a top-level
--     next_billing_date, and surfaces raw_period_start/frozen_days_applied on each billing period
--     for manager-facing auditability.
-- ---------------------------------------------------------------------------

create or replace function public.get_subscription_detail(p_subscription_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_versions jsonb;
  v_freezes jsonb;
  v_periods jsonb;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(v) - 'created_by' || jsonb_build_object(
    'display_status', public.subscription_version_display_status(v.id, public._studio_today_date()),
    'effective_plan_end_date', public.subscription_effective_plan_end_date(v.id),
    'allowances', (
      select coalesce(jsonb_object_agg(a.tier::text, a.weekly_limit), '{}'::jsonb)
      from public.subscription_version_allowances a where a.version_id = v.id
    )
  ) order by v.version_no), '[]'::jsonb)
  into v_versions
  from public.subscription_versions v
  where v.subscription_id = p_subscription_id;

  select coalesce(jsonb_agg(to_jsonb(f) order by f.freeze_from), '[]'::jsonb)
  into v_freezes
  from public.subscription_freezes f
  where f.subscription_id = p_subscription_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'period_id', bp.id,
    'period_start', bp.period_start,
    'period_end', bp.period_end,
    'raw_period_start', bp.raw_period_start,
    'raw_period_end', bp.raw_period_end,
    'frozen_days_applied', bp.frozen_days_applied,
    'charges', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb)
      from public.subscription_charges c where c.billing_period_id = bp.id
    )
  ) order by bp.raw_period_start), '[]'::jsonb)
  into v_periods
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_subscription_id;

  return json_build_object(
    'ok', true,
    'subscription', to_jsonb(v_sub),
    'versions', v_versions,
    'freezes', v_freezes,
    'billing_periods', v_periods,
    'next_billing_date', public.subscription_effective_next_billing_date(p_subscription_id)
  );
end;
$$;

comment on function public.get_subscription_detail(uuid) is
  'Manager-only. Full version/freeze/billing-period/charge history for one subscription, including '
  'tombstoned subscriptions. Each version now also reports effective_plan_end_date; the top level '
  'reports the effective next_billing_date; each billing period additionally reports its raw '
  'bounds and frozen_days_applied for auditability.';

grant execute on function public.get_subscription_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. get_my_subscription -- athlete-facing read model now reports the EFFECTIVE plan end / next
--     billing date, and the EFFECTIVE (prorated) weekly limit alongside the configured one.
-- ---------------------------------------------------------------------------

create or replace function public.get_my_subscription()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_version public.subscription_versions%rowtype;
  v_today date := public._studio_today_date();
  v_week_start date := v_today - extract(dow from v_today)::int;
  v_next_billing_date date;
  v_effective_plan_end_date date;
  v_current_freeze jsonb;
  v_upcoming_freeze jsonb;
  v_allowances jsonb;
  v_usage jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select s.* into v_sub
  from public.subscriptions s
  where s.payee_id = v_uid
    and s.payee_is_manual = false
    and s.deleted_at is null
  order by s.created_at desc
  limit 1;

  if not found then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  select v.* into v_version
  from public.subscription_versions v
  where v.subscription_id = v_sub.id and v.effective_to is null
  limit 1;

  if not found or public.subscription_version_display_status(v_version.id, v_today) in ('stopped', 'completed') then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  v_next_billing_date := public.subscription_effective_next_billing_date(v_sub.id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version.id);

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_current_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and v_today between f.freeze_from and f.freeze_until
  limit 1;

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_upcoming_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and f.freeze_from > v_today
  order by f.freeze_from asc
  limit 1;

  select coalesce(jsonb_object_agg(a.tier::text, a.weekly_limit), '{}'::jsonb)
  into v_allowances
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', a.tier,
      'configured_weekly_limit', a.weekly_limit,
      'effective_weekly_limit', public.subscription_effective_weekly_limit(v_sub.payee_id, false, a.tier, v_week_start),
      'used', coalesce((
        select count(*)
        from public.subscription_registration_coverage cov
        left join public.session_registrations reg on reg.id = cov.registration_id
        where cov.subscription_id = v_sub.id
          and cov.tier = a.tier
          and cov.week_start = v_week_start
          and cov.covered = true
          and (
            cov.manual_participant_id is not null
            or reg.status = 'active'
            or exists (
              select 1 from public.cancellations c
              where c.session_id = reg.session_id
                and c.user_id = reg.user_id
                and c.charged_full_price is true
            )
          )
      ), 0)
    )
    order by a.tier
  ), '[]'::jsonb)
  into v_usage
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

  return json_build_object(
    'ok', true,
    'has_subscription', true,
    'is_frozen', v_current_freeze is not null,
    'monthly_price_ils', v_version.monthly_price_ils,
    'plan_start_date', v_version.plan_start_date,
    'plan_end_date', v_version.plan_end_date,
    'effective_plan_end_date', v_effective_plan_end_date,
    'has_no_end_date', v_version.has_no_end_date,
    'next_billing_date', v_next_billing_date,
    'current_freeze', v_current_freeze,
    'upcoming_freeze', v_upcoming_freeze,
    'week_start', v_week_start,
    'allowances', v_allowances,
    'weekly_usage', v_usage
  );
end;
$$;

comment on function public.get_my_subscription() is
  'Athlete-safe self-read. next_billing_date and effective_plan_end_date now reflect cumulative '
  'freeze shift (subscription_effective_next_billing_date / subscription_effective_plan_end_date); '
  'plan_end_date keeps its original configured meaning alongside it. Each weekly_usage row reports '
  'both configured_weekly_limit and effective_weekly_limit (the latter prorated for this week''s '
  'frozen Sun-Fri days via subscription_effective_weekly_limit) -- the athlete UI must display '
  'effective_weekly_limit, never configured_weekly_limit, as the "of Y used" denominator.';

grant execute on function public.get_my_subscription() to authenticated;
