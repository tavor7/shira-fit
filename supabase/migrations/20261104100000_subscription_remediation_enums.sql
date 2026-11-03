-- Enum values for the subscription remediation. In their own migration because a value added by ALTER TYPE cannot be
-- used in the transaction that adds it. No data changes.
alter type public.subscription_non_coverage_reason add value if not exists 'no_show_released';
alter type public.subscription_non_coverage_reason add value if not exists 'paid_at_regular_price';
alter type public.subscription_non_coverage_reason add value if not exists 'subscription_deleted';
alter type public.subscription_impact_action_type add value if not exists 'unfreeze';
alter type public.subscription_impact_action_type add value if not exists 'delete';
alter type public.subscription_charge_type add value if not exists 'unfreeze_correction';
