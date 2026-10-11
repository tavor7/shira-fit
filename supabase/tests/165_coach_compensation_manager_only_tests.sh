#!/usr/bin/env bash
# Regression test for 20261014100000_coach_compensation_manager_only.sql (coach cannot change compensation).
#
# Every call goes over a real `authenticator` connection as anon / authenticated with JWT claims (one transaction per call,
# like PostgREST). Fixture: manager M, coach C (owns session S1, has a pay rate), coach C2 (owns session S2, has a pay
# rate), athlete A.
#   N  coach C cannot insert / update / delete their own pay rate, cannot touch C2's, cannot set a per-session coach payout,
#      cannot write training_sessions.custom_coach_rate_ils, cannot reassign C2's session (or its own) through
#      staff_update_session_series_scope, cannot edit C2's session there at all; athlete and anon are refused everything
#   P  manager keeps full compensation management; coach still reads own rates (and only own); coach still edits own
#      session (time / capacity) through staff_update_session_series_scope; compensation rows are unchanged by the refusals
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/165_coach_compensation_manager_only_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
# refused = permission denied, forbidden JSON, or an RLS-filtered empty result / zero-row write
refused() { case "$2" in *"permission denied"*|*forbidden*|*not_authenticated*|*"row-level security"*|"0"|""|"[]") ok "N $1 refused";; *) fail "N $1 NOT refused: $(echo "$2" | head -1 | cut -c1-140)";; esac; }
works() { case "$2" in *"permission denied"*|*forbidden*|*"row-level security"*|*ERROR*) fail "P $1: $(echo "$2" | grep -m1 -E 'ERROR|denied|forbidden' | cut -c1-160)";; *) ok "P $1";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); C2=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f165-$n-m@t.local', '091$n'), ('$C'::uuid, 'f165-$n-c@t.local', '092$n'),
               ('$C2'::uuid, 'f165-$n-c2@t.local', '093$n'), ('$A'::uuid, 'f165-$n-a@t.local', '094$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$C2','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id in ('$C','$C2')" >/dev/null
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 3, '07:15', '$C', 4, true) returning id" | head -1)
S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 3, '07:45', '$C2', 4, true) returning id" | head -1)
R1=$(su -c "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C', 4, 50, current_date - 30) returning id" | head -1)
R2=$(su -c "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C2', 4, 60, current_date - 30) returning id" | head -1)
snapshot() { su -c "select string_agg(id || ':' || coach_id || ':' || max_participants || ':' || price_ils || ':' || effective_from || ':' || coalesce(effective_to::text, '-'), ',' order by id) from public.coach_capacity_pricing where coach_id in ('$C','$C2')"; }
BEFORE=$(snapshot)

echo "== N: coach cannot change compensation (own or another coach's)"
refused "coach updates own pay rate" "$(api "$C" "with u as (update public.coach_capacity_pricing set price_ils = 999 where id = '$R1' returning 1) select count(*) from u;")"
refused "coach inserts a new own pay rate" "$(api "$C" "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C', 8, 999, current_date); select 1;")"
refused "coach deletes own pay rate" "$(api "$C" "with d as (delete from public.coach_capacity_pricing where id = '$R1' returning 1) select count(*) from d;")"
refused "coach updates another coach's pay rate" "$(api "$C" "with u as (update public.coach_capacity_pricing set price_ils = 1 where id = '$R2' returning 1) select count(*) from u;")"
refused "coach inserts a pay rate for another coach" "$(api "$C" "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C2', 9, 1, current_date); select 1;")"
refused "coach deletes another coach's pay rate" "$(api "$C" "with d as (delete from public.coach_capacity_pricing where id = '$R2' returning 1) select count(*) from d;")"
refused "coach upserts own pay rate (on conflict)" "$(api "$C" "insert into public.coach_capacity_pricing (id, coach_id, max_participants, price_ils, effective_from) values ('$R1', '$C', 4, 999, current_date - 30) on conflict (id) do update set price_ils = 999; select 1;")"
refused "coach truncates pay rates" "$(api "$C" "truncate public.coach_capacity_pricing; select 1;")"
refused "coach sets a per-session coach payout (RPC)" "$(api "$C" "select public.staff_set_session_custom_coach_rate('$S1', 999)::text;")"
refused "coach writes custom_coach_rate_ils directly" "$(api "$C" "with u as (update public.training_sessions set custom_coach_rate_ils = 999 where id = '$S1' returning 1) select count(*) from u;")"
refused "coach reassigns another coach's session to self" "$(api "$C" "select public.staff_update_session_series_scope('$S2', 'this', null, null, '$C', null, 60, null, null, null, null)::text;")"
refused "coach edits another coach's session (no reassignment)" "$(api "$C" "select public.staff_update_session_series_scope('$S2', 'this', null, '08:00', null, 6, 60, null, null, null, null)::text;")"
refused "coach hands own session to another coach" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, '$C2', null, 60, null, null, null, null)::text;")"
expect "C2's session still belongs to C2" "$C2" "$(su -c "select coach_id from public.training_sessions where id = '$S2'")"
expect "C's session still belongs to C" "$C" "$(su -c "select coach_id from public.training_sessions where id = '$S1'")"
expect "no per-session payout was set" "" "$(su -c "select custom_coach_rate_ils from public.training_sessions where id in ('$S1','$S2') and custom_coach_rate_ils is not null")"
for who in "athlete:$A" "anon:"; do label=${who%%:*}; u=${who#*:}; role=authenticated; [ "$label" = anon ] && role=anon
  refused "$label inserts a pay rate" "$(api_as $role "$u" "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C', 7, 1, current_date); select 1;")"
  refused "$label updates a pay rate" "$(api_as $role "$u" "with u as (update public.coach_capacity_pricing set price_ils = 1 where true returning 1) select count(*) from u;")"
  refused "$label reads pay rates" "$(api_as $role "$u" "select count(*) from public.coach_capacity_pricing where coach_id in ('$C','$C2');")"
  refused "$label edits a session through the series RPC" "$(api_as $role "$u" "select public.staff_update_session_series_scope('$S1', 'this', null, null, '$C2', null, 60, null, null, null, null)::text;")"
done
expect "refused writes left every compensation row unchanged" "$BEFORE" "$(snapshot)"

echo "== P: legitimate paths still work"
expect "coach reads own pay rate" "1" "$(api "$C" "select count(*) from public.coach_capacity_pricing where coach_id = '$C';" | tail -1)"
expect "coach does not read another coach's pay rate" "0" "$(api "$C" "select count(*) from public.coach_capacity_pricing where coach_id = '$C2';" | tail -1)"
R=$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, '07:30', null, 6, 60, null, null, null, null)::text;")
case "$R" in *'"ok" : true'*|*'"ok":true'*) ok "P coach edits own session time/capacity";; *) fail "P coach edits own session: $R";; esac
R=$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, '$C', null, 60, null, null, null, null)::text;")
case "$R" in *'"ok" : true'*|*'"ok":true'*) ok "P coach passes own id as coach (no change) on own session";; *) fail "P coach own id: $R";; esac
expect "own-session edit applied" "07:30:00|6" "$(su -c "select start_time || '|' || max_participants from public.training_sessions where id = '$S1'")"
works "manager updates a coach pay rate" "$(api "$M" "update public.coach_capacity_pricing set price_ils = 55 where id = '$R1'; select 1;")"
expect "manager update saved" "55.00" "$(su -c "select price_ils from public.coach_capacity_pricing where id = '$R1'")"
works "manager inserts a coach pay rate" "$(api "$M" "insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from) values ('$C', 8, 70, current_date); select 1;")"
works "manager deletes a coach pay rate" "$(api "$M" "delete from public.coach_capacity_pricing where coach_id = '$C' and max_participants = 8; select 1;")"
expect "manager insert + delete round-trip" "0" "$(su -c "select count(*) from public.coach_capacity_pricing where coach_id = '$C' and max_participants = 8")"
R=$(api "$M" "select public.staff_set_session_custom_coach_rate('$S2', 80)::text;")
case "$R" in *'"ok" : true'*|*'"ok":true'*) ok "P manager sets a per-session coach payout";; *) fail "P manager payout: $R";; esac
R=$(api "$M" "select public.staff_update_session_series_scope('$S2', 'this', null, null, '$C', null, 60, null, null, null, null)::text;")
case "$R" in *'"ok" : true'*|*'"ok":true'*) ok "P manager reassigns a session's coach";; *) fail "P manager reassign: $R";; esac
expect "manager reassignment applied" "$C" "$(su -c "select coach_id from public.training_sessions where id = '$S2'")"
works "manager reads all pay rates" "$(api "$M" "select count(*) from public.coach_capacity_pricing;")"

echo
echo "165 coach compensation manager-only: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
