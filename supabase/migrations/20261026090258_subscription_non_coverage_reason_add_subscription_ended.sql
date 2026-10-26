-- New non_coverage_reason value for subscription stop/delete's "keep registration, charge regular
-- price" future-registrations resolution (see 20261026180000). Added in its own migration/transaction
-- because a new enum value cannot be referenced by name in the same transaction that adds it.

alter type public.subscription_non_coverage_reason add value if not exists 'subscription_ended';

comment on type public.subscription_non_coverage_reason is
  'not_subscribed/tier_not_included/frozen/allowance_exceeded are reconcile-time reasons for an '
  'already-occurred session. subscription_ended is set only by _subscription_resolve_future_'
  'registrations (stop/delete''s "charge regular price" choice) on a FUTURE, not-yet-occurred '
  'registration whose subscription ended before its session date.';
