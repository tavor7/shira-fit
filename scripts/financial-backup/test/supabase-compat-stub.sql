-- Minimal Supabase-compatibility shim for restoring the financial backup into a TRULY clean,
-- non-Supabase PostgreSQL instance (e.g. a bare `postgres:17` container), proving the backup is
-- recoverable independent of Supabase itself.
--
-- A real Supabase-provisioned Postgres already has both of these natively -- this file is ONLY
-- needed for the "clean PostgreSQL environment" restore-test target, never for a real recovery
-- into a new or existing Supabase project.
--
-- Two concrete requirements found by reading the actual schema/trigger bodies, not assumed:
--   1. public.profiles.user_id has a real FK to auth.users(id) -- the schema dump's DDL for that
--      constraint will fail at restore time ("relation auth.users does not exist") without a
--      target for it.
--   2. Several receipt/document RPCs (cancel_document, create_document, ...) call auth.uid() to
--      identify the caller -- a Supabase GoTrue-specific function with no equivalent in stock
--      Postgres. The real implementation reads a JWT claim from a Postgres setting; this stub
--      reproduces just enough of that (a settable session variable) to let the same functions run
--      under test, exactly mirroring how this repo's own SQL test suite already does this
--      locally (see supabase/tests/*.sh, `set local request.jwt.claims`).

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
$$;

-- 3. public.system_monitoring_observer_health (an unrelated system-monitoring view, confirmed
--    the only public-schema view referencing the pg_cron extension's schema) joins against
--    cron.job / cron.job_run_details. pg_cron isn't installed in a stock postgres:17 image, so a
--    bare schema-only restore fails at CREATE VIEW time without these. Minimal stub -- not the
--    real extension, just enough shape for the view to compile; this view is non-financial and
--    is never queried as part of financial recovery.
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigint primary key,
  jobname text,
  schedule text,
  active boolean
);

create table if not exists cron.job_run_details (
  jobid bigint,
  start_time timestamptz,
  status text
);

-- 4. GRANT statements throughout the schema dump target Supabase's three standard database
--    roles (anon, authenticated, service_role) -- these are platform-managed roles, not schema
--    objects, and don't exist on stock Postgres at all.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- 5. btree_gist (a real extension, not a stub -- also required on a genuine Supabase restore
--    target if somehow missing) backs several GiST indexes on uuid columns. Installed into its
--    own `extensions` schema (matching Supabase's own convention, confirmed in production) so it
--    survives a `DROP SCHEMA public CASCADE` during restore prep.
create schema if not exists extensions;
create extension if not exists btree_gist schema extensions;
-- The restoring session's search_path must include this schema for the dump's unqualified
-- GiST-index DDL to find the opclass -- set at the database level before restoring:
--   ALTER DATABASE <target> SET search_path TO public, extensions;
