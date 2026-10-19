-- Regression tests for 20261020150000_system_client_reporting_flag.sql.
-- Self-contained; rolled back at the end.
set client_min_messages to notice;
begin;

do $$
declare
  v_val boolean;
begin
  -- F1: mirrors client_ingest_enabled exactly, in both directions.
  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
  v_val := public.system_client_reporting_enabled();
  if v_val is distinct from false then
    raise exception 'F1 FAILED: expected false, got %', v_val;
  end if;

  update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';
  v_val := public.system_client_reporting_enabled();
  if v_val is distinct from true then
    raise exception 'F1 FAILED: expected true, got %', v_val;
  end if;

  update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';
  raise notice 'F1 PASSED: system_client_reporting_enabled() mirrors client_ingest_enabled in both directions';
end $$;

-- F2: authorization - anon cannot call it; authenticated can.
do $$
begin
  if has_function_privilege('anon', 'public.system_client_reporting_enabled()'::regprocedure, 'EXECUTE') then
    raise exception 'F2 FAILED: anon must not be able to call system_client_reporting_enabled';
  end if;
  if not has_function_privilege('authenticated', 'public.system_client_reporting_enabled()'::regprocedure, 'EXECUTE') then
    raise exception 'F2 FAILED: authenticated must be able to call system_client_reporting_enabled';
  end if;
  if has_function_privilege('service_role', 'public.system_client_reporting_enabled()'::regprocedure, 'EXECUTE') then
    raise exception 'F2 FAILED: service_role should not need this client-facing RPC';
  end if;
  raise notice 'F2 PASSED: system_client_reporting_enabled() authorization matches authenticated-only';
end $$;

-- F3: the function is a plain SQL boolean return with no side channel - it cannot be used to read
-- any other monitoring config key (verified by signature: no arguments, boolean return).
do $$
declare
  v_argtypes text;
  v_rettype text;
begin
  select pg_catalog.pg_get_function_arguments(oid), pg_catalog.format_type(prorettype, null)
  into v_argtypes, v_rettype
  from pg_proc where oid = 'public.system_client_reporting_enabled()'::regprocedure;

  if coalesce(v_argtypes, '') <> '' or v_rettype <> 'boolean' then
    raise exception 'F3 FAILED: expected a zero-argument function returning boolean, got args=(%) returns %', v_argtypes, v_rettype;
  end if;
  raise notice 'F3 PASSED: system_client_reporting_enabled() takes no arguments and returns only a boolean';
end $$;

rollback;
