// Single source of truth for what this backup covers. Derived from a live schema inspection
// (FKs, triggers, and trigger function bodies read directly from production), not assumed.
//
// Schema scope: public + archive, in full (schema-only). Cheap (DDL only) and this is what makes
// restore actually work -- see TABLE_SCOPE's "context" tables below for why a data-only dump of
// just the obviously-financial tables is NOT sufficient on its own.
export const SCHEMA_SCOPE = ["public", "archive"];

// Data scope: the financial-domain tables, PLUS the non-financial "context" tables that financial
// triggers/FKs actually require at restore time. Confirmed by reading trigger function bodies:
//   - _validate_athlete_account_payment() looks up public.profiles / public.manual_participants
//     for the payee on every INSERT/UPDATE of athlete_account_payments (fires during a COPY-based
//     data restore, not just live writes) -- so those two tables must be present with matching
//     rows, or the restore must disable triggers for the load (see restore.js).
//   - session_registrations/session_manual_participants/session_roster_slot_prices FK to
//     public.training_sessions.
//   - documents/document_events/archive.* reference public.customers and public.profiles
//     (created_by/cancelled_by).
export const FINANCIAL_TABLES = [
  "public.receipt_settings",
  "public.customers",
  "public.documents",
  "public.document_events",
  "public.external_manual_receipts",
  "public.athlete_account_payments",
  "public.session_registrations",
  "public.session_manual_participants",
  "public.session_roster_slot_prices",
  "public.subscriptions",
  "public.subscription_versions",
  "public.subscription_billing_periods",
  "public.subscription_charges",
  "public.subscription_freezes",
  "public.subscription_registration_coverage",
  "archive.document_pdf_versions",
  "archive.r2_archive_jobs",
];

// Non-financial context tables required for the above to restore and function (attribution,
// FK targets, trigger validation targets) -- NOT the full non-financial dataset, just these.
export const CONTEXT_TABLES = ["public.profiles", "public.manual_participants", "public.training_sessions"];

export const DATA_TABLES = [...FINANCIAL_TABLES, ...CONTEXT_TABLES];

// public.profiles.user_id has a real FK to auth.users (Supabase-managed schema, deliberately
// excluded from SCHEMA_SCOPE -- we don't want to duplicate real auth/credential data). Restoring
// into anything other than a Supabase-provisioned Postgres (which already has a real `auth`
// schema) therefore needs a minimal compatibility stub first -- see test/supabase-compat-stub.sql.
export const REQUIRES_AUTH_SCHEMA_STUB_OUTSIDE_SUPABASE = true;
