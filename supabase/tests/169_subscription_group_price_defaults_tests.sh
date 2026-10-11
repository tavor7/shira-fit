#!/usr/bin/env bash
# Regression test for 20261014140000_subscription_group_price_defaults.sql.
#
# Real table access over an `authenticator` connection (JWT claims, one transaction per call, like PostgREST).
#   P  manager creates / reads / updates / deletes the 1-4 group-session default prices; updated_by is the manager
#   N  coach, athlete and anon cannot read or write them; quotas outside 1-4, negative / absurd prices are rejected
#      server-side; nothing is seeded
#   R  changing a default never touches an existing subscription's price, its charges or the billing job's output
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/169_subscription_group_price_defaults_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
contains() { case "$3" in *"$2"*) ok "$1";; *) fail "$1: expected '$2' in '$(echo "$3" | head -2 | cut -c1-200)'";; esac; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
refused() { case "$2" in *"permission denied"*|*"row-level security"*|"0"|"") ok "N $1 refused";; *) fail "N $1 NOT refused: $(echo "$2" | head -1 | cut -c1-140)";; esac; }
T=public.subscription_group_price_defaults

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); A=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f169-$n-' || u.k || '@t.local',
         jsonb_build_object('full_name', 'F169 ' || u.k, 'phone', '08' || u.k || '$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, '1'), ('$C'::uuid, '2'), ('$A'::uuid, '3')) u(id, k);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "delete from $T" >/dev/null   # scratch database: start from the shipped (empty) state

echo "== nothing seeded; manager manages the defaults"
expect "no default price is seeded" "0" "$(su -c "select count(*) from $T")"
contains "manager inserts 1-4" "INSERT" "$(api "$M" "insert into $T (group_sessions_per_week, monthly_price_ils) values (1, 250), (2, 400), (3, 520), (4, 600);" ; echo INSERT)"
expect "manager reads them" "1:250.00,2:400.00,3:520.00,4:600.00" "$(api "$M" "select string_agg(group_sessions_per_week || ':' || monthly_price_ils, ',' order by group_sessions_per_week) from $T;" | tail -1)"
expect "updated_by is the manager" "$M" "$(su -c "select distinct updated_by from $T")"
api "$M" "update $T set monthly_price_ils = 420.50 where group_sessions_per_week = 2;" >/dev/null
expect "manager updates (two decimals kept)" "420.50" "$(su -c "select monthly_price_ils from $T where group_sessions_per_week = 2")"
api "$M" "delete from $T where group_sessions_per_week = 4;" >/dev/null
expect "manager deletes (back to no suggestion)" "0" "$(su -c "select count(*) from $T where group_sessions_per_week = 4")"

echo "== server-side validation"
for bad in "0, 100" "5, 100" "-1, 100" "3, -1" "3, 100001"; do
  contains "rejects ($bad)" "violates check constraint" "$(api "$M" "insert into $T (group_sessions_per_week, monthly_price_ils) values ($bad) on conflict (group_sessions_per_week) do update set monthly_price_ils = excluded.monthly_price_ils;")"
done
contains "rejects a missing price" "null value" "$(api "$M" "insert into $T (group_sessions_per_week, monthly_price_ils) values (4, null);")"

echo "== coach / athlete / anon are refused"
for who in "coach:$C" "athlete:$A" "anon:"; do l=${who%%:*}; u=${who#*:}; role=authenticated; [ "$l" = anon ] && role=anon
  refused "$l reads defaults" "$(api_as $role "$u" "select count(*) from $T;" | tail -1)"
  refused "$l inserts a default" "$(api_as $role "$u" "insert into $T (group_sessions_per_week, monthly_price_ils) values (4, 1); select 1;")"
  refused "$l updates a default" "$(api_as $role "$u" "with u as (update $T set monthly_price_ils = 1 where true returning 1) select count(*) from u;" | tail -1)"
  refused "$l deletes a default" "$(api_as $role "$u" "with d as (delete from $T where true returning 1) select count(*) from d;" | tail -1)"
  refused "$l truncates" "$(api_as $role "$u" "truncate $T; select 1;")"
done
expect "refused writes changed nothing" "1:250.00,2:420.50,3:520.00" "$(su -c "select string_agg(group_sessions_per_week || ':' || monthly_price_ils, ',' order by group_sessions_per_week) from $T")"

echo "== R: defaults never change existing subscriptions or billing"
TODAY=$(su -c "select public._studio_today_date()")
SUB=$(jf "$(api "$M" "select public.create_subscription('$A', false, 400, '$TODAY', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;" | grep '^{')" subscription_id)
BEFORE=$(su -c "select (select string_agg(monthly_price_ils::text, ',') from public.subscription_versions where subscription_id = '$SUB') || '|' || (select string_agg(amount_ils::text || charge_type, ',' order by created_at) from public.subscription_charges where subscription_id = '$SUB')")
api "$M" "update $T set monthly_price_ils = 999 where group_sessions_per_week = 2;" >/dev/null
su -c "select public.generate_due_subscription_charges()" >/dev/null
expect "existing subscription price and charges unchanged after a default changes" "$BEFORE" "$(su -c "select (select string_agg(monthly_price_ils::text, ',') from public.subscription_versions where subscription_id = '$SUB') || '|' || (select string_agg(amount_ils::text || charge_type, ',' order by created_at) from public.subscription_charges where subscription_id = '$SUB')")"
expect "billing never reads the defaults table" "0" "$(su -c "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname <> '_subscription_group_price_defaults_stamp' and prosrc like '%subscription_group_price_defaults%'")"

su -c "delete from $T" >/dev/null
echo
echo "169 subscription group price defaults: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
