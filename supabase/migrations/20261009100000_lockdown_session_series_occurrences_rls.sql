-- Security remediation: close the anonymous/API exposure of the recurring-series occurrence-identity ledger.
--
-- public.session_series_occurrences was created (20261001150000) without RLS, and the platform default
-- privileges granted anon/authenticated/service_role every table privilege (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER). Because the table is in the PostgREST-exposed `public` schema, this made the
-- ledger anonymously readable AND writable over the API. A forged future row with state='deleted' suppresses
-- legitimate horizon generation (Supabase advisor: rls_disabled_in_public, ERROR).
--
-- The ledger is an INTERNAL identity map. All legitimate access is through postgres-owned SECURITY DEFINER
-- recurring-series functions (_maintain_session_series_horizon_core, _generate_series_occurrence_claim,
-- staff_*_session_series_scope, ...). Those run as the table owner (postgres), so they are unaffected by RLS
-- and by API-role grants. The investigation and the request logs found no direct mobile/client/Edge caller,
-- and no grep hit in mobile/src or supabase/functions.
--
-- This migration therefore makes the table fail-closed to every API role and adds NO policy (an internal table
-- needs none; a permissive policy purely to silence the advisor is explicitly avoided). It changes no rows, no
-- columns, no constraints, no indexes, no foreign keys, and no function bodies.
--
-- Scope is deliberately this one table. It does NOT touch default privileges, other tables, user_activity_events,
-- the is_manager/is_coach helpers, monitoring, or cron. Idempotent and safe to replay.

-- 1) Fail closed: enable row-level security. With no policy, non-owner roles see/write nothing; the owning
--    postgres role (and SECURITY DEFINER functions running as it) is unaffected. service_role also bypasses RLS
--    by role attribute, which is why the privilege REVOKE below (not RLS alone) is what actually closes it off.
alter table public.session_series_occurrences enable row level security;

-- 2) Remove every direct table privilege from PUBLIC and the API roles. REVOKE ALL is safe here: the only
--    authorized access path is the postgres-owned definer functions, which do not rely on these grants.
revoke all on table public.session_series_occurrences from public;
revoke all on table public.session_series_occurrences from anon;
revoke all on table public.session_series_occurrences from authenticated;

-- 3) service_role: the investigation found no Edge/client requirement for direct access to this internal ledger,
--    so it is revoked too rather than left broad on the assumption that a privileged role must keep it. (Even if
--    kept, service_role bypasses RLS; removing the grant is the actual lock.) Re-grant in a reviewed migration if
--    a concrete server-side need ever appears.
revoke all on table public.session_series_occurrences from service_role;

comment on table public.session_series_occurrences is
  'Internal recurring-series occurrence-identity ledger. RLS enabled, no policies, no privileges for '
  'public/anon/authenticated/service_role: all access is through postgres-owned SECURITY DEFINER series '
  'functions. Hardened by 20261009100000 (was anonymously readable/writable via PostgREST).';
