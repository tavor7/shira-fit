-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 1a).
-- New enum values only — kept in their own migration/transaction so later migrations
-- can safely reference them (Postgres disallows using a new enum value in the same
-- transaction that adds it).

alter type public.legal_consent_type add value if not exists 'marketing_communications';

create type public.communication_category as enum ('operational', 'marketing');
