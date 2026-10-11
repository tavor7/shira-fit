-- Subscription terms consent (step 1 of 2): new consent type only.
-- Kept in its own migration/transaction because Postgres does not allow using a new enum value in the same transaction
-- that adds it (same pattern as 20260915100000_legal_consent_enum_values.sql).

alter type public.legal_consent_type add value if not exists 'subscription_terms';
