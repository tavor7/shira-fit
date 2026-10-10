#!/usr/bin/env bash
# Proves that applying 20261011100000_job_issue_reporting_dry_run.sql changes NO business data: inside one rolled-back transaction it
# creates fixture rows (users, session, registration, cancellation incl. a charged one, history, waitlist), fingerprints EVERY public
# table that is not a monitoring table, runs the migration file itself, fingerprints again and requires identical results. It also
# checks that the migration leaves shadow=true / report_enabled=false and the effective issue mode at dry_run, and creates no
# monitoring issue row.
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/157_job_issue_migration_no_business_change.sh
set -eu
PSQL=${PSQL:?set PSQL}
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations/20261011100000_job_issue_reporting_dry_run.sql"
{
cat <<'SQL'
\set ON_ERROR_STOP on
begin;
do $$
declare a uuid := gen_random_uuid(); c uuid := gen_random_uuid(); s uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (a,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','m157a@t.local', jsonb_build_object('full_name','a','phone','0501570001','gender','female','address','A','zip_code','1'), now(), now()),
    (c,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','m157c@t.local', jsonb_build_object('full_name','c','phone','0501570002','gender','female','address','A','zip_code','1'), now(), now());
  update public.profiles set approval_status='approved' where user_id in (a, c);
  update public.profiles set role='coach' where user_id = c;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, duration_minutes) values (current_date - 3, '18:00', c, 3, 60) returning id into s;
  insert into public.session_registrations (session_id, user_id, status) values (s, a, 'cancelled');
  insert into public.cancellations (session_id, user_id, reason, charged_full_price, penalty_collected_ils) values (s, a, 'x', true, 0);
  insert into public.registration_history (session_id, user_id, event_type, meta) values (s, a, 'cancelled', '{"late_cancellation": true}'::jsonb);
  insert into public.waitlist_requests (session_id, user_id) values (s, a);
end $$;
create temp table fp_before as
select c.relname::text t, (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text::bigint n,
       (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) h from public.%I x', '|', '', c.relname), false, true, '')))[1]::text h
from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname not like 'system\_%';
create temp table cfg_before as select value from public.system_monitoring_config where key in ('client_ingest_enabled', 'ingest_enabled', 'limits', 'retention', 'context_allowed_keys');
SQL
cat "$MIG"
cat <<'SQL'
do $$
declare r record; v_after record; bad int := 0; v_n int := 0;
begin
  for r in select * from fp_before loop
    v_n := v_n + 1;
    execute format('select count(*) n, md5(coalesce(string_agg(x::text, %L order by x::text), %L)) h from public.%I x', '|', '', r.t) into v_after;
    if v_after.n <> r.n or v_after.h <> r.h then raise warning 'business table % changed (% -> %)', r.t, r.n, v_after.n; bad := bad + 1; end if;
  end loop;
  if bad > 0 then raise exception 'NO-BUSINESS-CHANGE FAILED: % table(s) changed', bad; end if;
  if (select count(*) from public.system_issues) + (select count(*) from public.system_issue_events) <> 0 then raise exception 'NO-BUSINESS-CHANGE FAILED: monitoring rows were created'; end if;
  if public._system_job_issue_mode() <> 'dry_run' then raise exception 'NO-BUSINESS-CHANGE FAILED: effective mode is not dry_run'; end if;
  if (select value ->> 'shadow' from public.system_monitoring_config where key='job_monitoring') <> 'true'
     or (select value ->> 'report_enabled' from public.system_monitoring_config where key='job_monitoring') <> 'false' then
    raise exception 'NO-BUSINESS-CHANGE FAILED: shadow/report_enabled changed';
  end if;
  if (select count(*) from public.system_monitoring_config where key in ('client_ingest_enabled', 'ingest_enabled', 'limits', 'retention', 'context_allowed_keys')
        and value not in (select value from cfg_before)) <> 0 then raise exception 'NO-BUSINESS-CHANGE FAILED: other monitoring config changed'; end if;
  raise notice 'NO-BUSINESS-CHANGE PASSED: % non-monitoring public tables byte-identical; no monitoring row created; shadow=true, report_enabled=false, mode=dry_run; other config untouched', v_n;
end $$;
rollback;
SQL
} | $PSQL -v ON_ERROR_STOP=1 -f - 2>&1 | grep -E "NO-BUSINESS-CHANGE|ERROR|WARNING|FAILED" || { echo "FAILED: no result line"; exit 1; }
