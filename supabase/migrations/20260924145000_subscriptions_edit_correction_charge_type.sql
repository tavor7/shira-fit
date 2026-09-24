-- Subscription Management — Phase 4A prerequisite: new subscription_charge_type value.
--
-- 'edit_correction' is used by edit_subscription_version's billing-correction call (in the
-- following migration) when a price/plan change requires reversing and re-charging an
-- already-billed period. It must NOT reuse 'proration' (Phase 3's organic-partial-period type):
-- subscription_charges_original_per_period_uidx is a partial unique index on billing_period_id
-- WHERE charge_type IN ('recurring', 'proration'), guaranteeing exactly one "original" charge per
-- period — 'proration' is deliberately inside that index's scope, so inserting a second charge of
-- that type for an already-charged period collides with it. Phase 3's own correction types
-- (freeze_credit, stop_proration) were deliberately chosen to fall OUTSIDE that scope for exactly
-- this reason; edit corrections need their own type for the same reason.
--
-- Kept in its own migration/transaction, per this codebase's established convention (see
-- 20260915100000_legal_consent_enum_values.sql), since Postgres disallows using a new enum value
-- in the same transaction that adds it.

alter type public.subscription_charge_type add value if not exists 'edit_correction';
