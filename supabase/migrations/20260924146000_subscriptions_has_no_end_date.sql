-- Subscription Management — Phase 4A fix (pre-merge review, round 2): eliminate the is_unlimited /
-- weekly-allowance conflation.
--
-- Re-inspection confirms the product requirement: "unlimited / no end" in the plan
-- (/Users/amit/.claude/plans/golden-whistling-jellyfish.md line 24) refers exclusively to
-- subscription DURATION (paired with plan_end_date in the same subscription_versions row spec,
-- and used by subscription_version_display_status's 'completed' check — line 29 of the plan: "if
-- plan_end_date is set and as_of_date > plan_end_date"). It has never meant, and must never mean,
-- unlimited WEEKLY SESSIONS. Weekly allowance is governed exclusively by
-- subscription_version_allowances.weekly_limit, read by subscription_effective_context /
-- subscription_reserve_or_reject / subscription_reconcile_week — none of which have ever read
-- is_unlimited. The Phase 4A migration's 100000-sentinel workaround was itself the bug: it made
-- "no end date" silently ALSO mean "unlimited weekly sessions", which is being removed here.
--
-- Fix: rename is_unlimited -> has_no_end_date (eliminating the ambiguous name entirely, safe to do
-- pre-merge since this column has never been referenced by any merged/main code or by mobile) and
-- turn it into a GENERATED column so it can never again drift from what it actually measures —
-- structurally impossible to conflate with allowances from this point on, since it no longer takes
-- an independent value at all.

alter table public.subscription_versions drop column is_unlimited;

alter table public.subscription_versions
  add column has_no_end_date boolean generated always as (plan_end_date is null) stored;

comment on column public.subscription_versions.has_no_end_date is
  'Derived, never independently settable: true iff plan_end_date is null. Duration/end-date '
  'semantics ONLY -- has no relationship to and must never influence weekly session allowances '
  '(subscription_version_allowances.weekly_limit), which are configured completely independently. '
  'A GENERATED column specifically so this invariant cannot drift or be reintroduced by a future '
  'bug: there is no independent value to set incorrectly.';

-- ---------------------------------------------------------------------------
-- Relax subscription_versions_dates_chk from a strict "effective_to > effective_from" to
-- "effective_to >= effective_from", to support one narrow, deliberate case needed by
-- edit_subscription_version's "from the beginning" mode when the current version already has
-- billing/coverage history (see the Phase 4A backend migration's item-2 fix): a version that is
-- immediately, fully superseded at its own effective_from becomes a zero-real-duration audit stub
-- (effective_from = effective_to = X). This is verified safe against
-- subscription_billing_period_segments: such a version can never match any real segment (its own
-- join condition requires effective_to > segment_start AND effective_from <= segment_start, which
-- are mutually exclusive when effective_from = effective_to), so it is provably inert for pricing
-- and coverage purposes -- purely a historical record of "what was configured before it was
-- immediately corrected", preserving full auditability without ever contributing a billable day.
alter table public.subscription_versions
  drop constraint subscription_versions_dates_chk;
alter table public.subscription_versions
  add constraint subscription_versions_dates_chk check (effective_to is null or effective_to >= effective_from);
