#!/usr/bin/env bash
# Proves that applying 20261010100000_reconcile_waitlist_and_cancel_registration.sql changes NO existing business data.
#
# Inside one transaction (rolled back): create pre-existing fixture rows that mimic production history -- cancellations
# marked charged (with and without collected penalty), uncharged ones, history rows, waitlist rows, registrations --
# fingerprint every row of the four tables, run the migration file, fingerprint again, and require byte-identical
# fingerprints. The migration is executed from the file itself, so this tests the real deployable SQL.
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/151_waitlist_cancel_migration_no_backfill.sh
set -eu
PSQL=${PSQL:?set PSQL, e.g. "docker exec -i supabase_db_x psql -U postgres"}
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations/20261010100000_reconcile_waitlist_and_cancel_registration.sql"
[ -f "$MIG" ] || { echo "migration file not found: $MIG"; exit 1; }

# the migration must contain no data-modifying statement at the top level (it may only contain CREATE OR REPLACE FUNCTION and a self-check DO)
STRIPPED=$(perl -0pe 's/--[^\n]*//g; s/\$\$.*?\$\$//gs' "$MIG")
if echo "$STRIPPED" | grep -qiE '(^|;)\s*(insert|update|delete|truncate|alter|drop|grant|revoke|create (table|index|trigger|policy))\b'; then
  echo "FAILED: migration contains a statement other than function definitions + self-check"; exit 1
fi
echo "  PASSED: the migration contains only CREATE OR REPLACE FUNCTION statements and a self-check (no DML / DDL / grant)"

{
cat <<'SQL'
\set ON_ERROR_STOP on
begin;
create temp table fx (k text primary key, v uuid);
do $$
declare r record; v_id uuid; s_old uuid; s_fut uuid; coach uuid := gen_random_uuid();
begin
  for r in select * from (values ('coach','h-coach@t151.local','0501510001'),('a1','h-a1@t151.local','0501510002'),('a2','h-a2@t151.local','0501510003'),
                                 ('a3','h-a3@t151.local','0501510004'),('a4','h-a4@t151.local','0501510005'),('dis','h-dis@t151.local','0501510006')) x(k,e,p) loop
    v_id := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (v_id,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',r.e,
            jsonb_build_object('full_name',r.e,'phone',r.p,'gender','female','address','A','zip_code','1'),now(),now());
    insert into fx values (r.k, v_id);
  end loop;
  update public.profiles set approval_status='approved' where user_id in (select v from fx);
  update public.profiles set role='coach' where user_id=(select v from fx where k='coach');
  update public.profiles set disabled_at=now() - interval '3 days' where user_id=(select v from fx where k='dis');

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, duration_minutes)
  values (current_date - 20, '18:00', (select v from fx where k='coach'), 5, 60) returning id into s_old;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, duration_minutes)
  values (current_date + 20, '18:00', (select v from fx where k='coach'), 1, 60) returning id into s_fut;

  -- historical cancellations exactly like production's "54 charged" rows and others
  insert into public.session_registrations (session_id, user_id, status) values
    (s_old, (select v from fx where k='a1'), 'cancelled'), (s_old, (select v from fx where k='a2'), 'cancelled'),
    (s_old, (select v from fx where k='a3'), 'cancelled'), (s_old, (select v from fx where k='dis'), 'cancelled'),
    (s_fut, (select v from fx where k='a4'), 'active');
  insert into public.cancellations (session_id, user_id, reason, cancelled_at, charged_full_price, penalty_collected_ils, payment_method) values
    (s_old, (select v from fx where k='a1'), 'r1', now() - interval '19 days', true, 0, null),
    (s_old, (select v from fx where k='a2'), 'r2', now() - interval '19 days', true, 0, null),
    (s_old, (select v from fx where k='a3'), 'r3', now() - interval '19 days', false, 0, null),
    (s_old, (select v from fx where k='dis'), 'r4', now() - interval '19 days', true, 50, 'cash');
  insert into public.registration_history (session_id, user_id, event_type, meta) values
    (s_old, (select v from fx where k='a1'), 'cancelled', '{"charged_full_price": true}'::jsonb),
    (s_old, (select v from fx where k='a2'), 'cancelled', '{"late_cancellation": true, "charged_full_price": true}'::jsonb);
  insert into public.waitlist_requests (session_id, user_id) values (s_fut, (select v from fx where k='a3'));
end $$;

create temp table fp_before as
select 'cancellations' t, count(*) n, md5(coalesce(string_agg(c::text,'|' order by c.id),'')) h from public.cancellations c
union all select 'registration_history', count(*), md5(coalesce(string_agg(x::text,'|' order by x.id),'')) from public.registration_history x
union all select 'waitlist_requests', count(*), md5(coalesce(string_agg(w::text,'|' order by w.id),'')) from public.waitlist_requests w
union all select 'session_registrations', count(*), md5(coalesce(string_agg(r::text,'|' order by r.id),'')) from public.session_registrations r
union all select 'training_sessions', count(*), md5(coalesce(string_agg(s::text,'|' order by s.id),'')) from public.training_sessions s;
select 'fixture charged rows: ' || count(*) from public.cancellations where charged_full_price;
SQL
cat "$MIG"
cat <<'SQL'
do $$
declare r record; v_after record; bad int := 0;
begin
  for r in select * from fp_before loop
    execute format('select count(*) n, md5(coalesce(string_agg(x::text, %L order by x.id), %L)) h from public.%I x', '|', '', r.t) into v_after;
    if v_after.n <> r.n or v_after.h <> r.h then
      raise warning 'table % changed by the migration (% -> %)', r.t, r.n, v_after.n; bad := bad + 1;
    end if;
  end loop;
  if bad > 0 then raise exception 'NO-BACKFILL FAILED: % table(s) changed', bad; end if;
  raise notice 'NO-BACKFILL PASSED: cancellations / registration_history / waitlist_requests / session_registrations / training_sessions are byte-identical after the migration (incl. charged and penalty-collected rows)';
end $$;
rollback;
SQL
} | $PSQL -v ON_ERROR_STOP=1 -f - 2>&1 | grep -E "NO-BACKFILL|fixture charged|ERROR|WARNING|FAILED" || { echo "FAILED: no result line"; exit 1; }
