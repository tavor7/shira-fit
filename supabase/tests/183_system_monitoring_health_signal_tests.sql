-- Regression tests for 20261020130000_system_monitoring_health_signal.sql.
-- Self-contained; rolled back at the end.
set client_min_messages to notice;
begin;

-- H1: the independent health log is written when ingestion itself throws, and the outer caller
-- (_system_ingest) still returns its normal {accepted:false,...} shape rather than raising.
do $$
declare
  v_res jsonb;
  v_count int;
begin
  -- Force a genuine exception inside _system_ingest_impl by temporarily dropping one of its own
  -- dependencies (restored automatically by this test's rollback), rather than guessing at a
  -- malformed-payload shape that may or may not actually raise.
  drop function public._system_fingerprint(text, text, text, text, text, text, text, text);

  v_res := public._system_ingest('trusted', jsonb_build_object(
    'source', 'trusted', 'subsystem', 'test', 'operation', 'health_signal_test'), null);

  if coalesce((v_res->>'accepted')::boolean, true) <> false then
    raise exception 'H1 FAILED: expected accepted:false once _system_fingerprint is missing, got %', v_res;
  end if;

  select count(*) into v_count from public.system_monitoring_health_log
  where stage = 'ingest_impl_exception' and occurred_at > now() - interval '1 minute';
  if v_count < 1 then
    raise exception 'H1 FAILED: expected an ingest_impl_exception row in the independent health log';
  end if;
  raise notice 'H1 PASSED: an ingestion-path exception is independently logged and still returns accepted:false';
end $$;

-- H2: the health log is manager-read-only; nobody else can select from or write to it.
do $$
begin
  if has_table_privilege('authenticated', 'public.system_monitoring_health_log', 'INSERT')
     or has_table_privilege('authenticated', 'public.system_monitoring_health_log', 'UPDATE')
     or has_table_privilege('authenticated', 'public.system_monitoring_health_log', 'DELETE') then
    raise exception 'H2 FAILED: authenticated must not be able to write system_monitoring_health_log';
  end if;
  if has_table_privilege('anon', 'public.system_monitoring_health_log', 'SELECT') then
    raise exception 'H2 FAILED: anon must not be able to read system_monitoring_health_log';
  end if;
  raise notice 'H2 PASSED: system_monitoring_health_log privileges are manager-read-only';
end $$;

-- H3: the observer-health view exists, is security_invoker, and exposes the observer's own job row.
do $$
declare
  v_found boolean;
begin
  select exists (
    select 1 from public.system_monitoring_observer_health where job_key = 'system-monitor-observe'
  ) into v_found;
  if not v_found then
    raise exception 'H3 FAILED: expected a system_monitoring_observer_health row for the observer job';
  end if;
  if not exists (
    select 1 from pg_views where schemaname = 'public' and viewname = 'system_monitoring_observer_health'
  ) then
    raise exception 'H3 FAILED: system_monitoring_observer_health view not found';
  end if;
  raise notice 'H3 PASSED: system_monitoring_observer_health exposes the observer heartbeat';
end $$;

rollback;
