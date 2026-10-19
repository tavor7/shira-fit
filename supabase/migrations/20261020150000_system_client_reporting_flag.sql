-- System Issues monitoring completion, item 4: a minimal, authoritative server-side switch for
-- client error reporting that does not require a new app deployment to flip.
--
-- Previously the only control was a hardcoded build-time constant in the mobile app
-- (REMOTE_TECHNICAL_REPORTING_ENABLED), so turning reporting on or off in production required
-- shipping a new build. This RPC exposes the existing client_ingest_enabled config value (no new
-- config key) so the app can read and cache it, making production activation/deactivation a single
-- config-table UPDATE. Disabled by default; the client fails closed if this RPC is unreachable
-- (see mobile/src/lib/remoteReporting - the cache is never treated as "enabled" until a successful
-- read says so). Returns nothing else from system_monitoring_config - no limits, no rules, no
-- allowlist details - to avoid handing clients anything beyond the one boolean they need.
create or replace function public.system_client_reporting_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._system_flag('client_ingest_enabled', false);
$$;

revoke all on function public.system_client_reporting_enabled() from public, anon, service_role;
grant execute on function public.system_client_reporting_enabled() to authenticated;

comment on function public.system_client_reporting_enabled() is
  'Authoritative, server-controlled switch for client-side technical error reporting. Mirrors '
  'system_monitoring_config.client_ingest_enabled as a single boolean so production can be flipped '
  'without a new app deployment. Authenticated only; exposes nothing else from monitoring config.';

do $$
begin
  if has_function_privilege('anon', 'public.system_client_reporting_enabled()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: system_client_reporting_enabled must not be executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.system_client_reporting_enabled()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: system_client_reporting_enabled must be executable by authenticated';
  end if;
end $$;
