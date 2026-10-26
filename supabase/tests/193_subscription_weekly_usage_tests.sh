#!/usr/bin/env bash
# Regression suite for 20261026142511 (fix get_subscription_weekly_usage's json/jsonb concat bug).
#
# Bug: the function's final RETURN concatenated json_build_object(...) (type json) with
# _subscription_week_days(...) (type jsonb) via `||` -- an operator that does not exist for json||jsonb
# (only jsonb||jsonb is defined) -- so EVERY call failed with "operator does not exist: json || jsonb",
# for every subscription, every week, unconditionally. Reproduced in production for subscription
# 52be2192-a88d-4007-b0c7-b4c4b73e5ed9 (plan starting Sunday 2026-10-25); the UI swallowed the real
# error into a generic "Couldn't load this week's usage." message. Fix: compute the merge in jsonb
# (where || is valid), cast to json only at the very end -- same returns json signature, no DROP
# FUNCTION, no change to authorization/grants/search_path/business logic.
#
# Drives the REAL get_subscription_weekly_usage RPC over an `authenticator` connection with JWT
# claims, exactly like PostgREST -- same harness as 159/182/190/191/192.
#
# Scenarios
#   A  a subscription starting on a SUNDAY (exactly the reported production scenario) -- the RPC for
#      its first week returns ok:true with a well-formed response, not the json/jsonb operator error
#   B  a subscription starting MID-WEEK (Wednesday) -- same, including for a week before any
#      registration exists (zero usage, not an error)
#   C  response structure and values: usage[] has one row per tier with a nonzero configured limit
#      (matches the allowance given at creation), used/extra are 0 with no registrations yet,
#      week_start/week_end bound the studio week, window_days/active_days/frozen_days are present
#   D  unauthorized access: anon reaches the function (not blocked at the grant layer, same as the
#      rest of this codebase's un-hardened subscription RPCs) but gets {ok:false,error:forbidden}, not
#      an exception; an authenticated non-manager (the subscription's own athlete) gets the same
#   E  a nonexistent subscription id returns {ok:false,error:subscription_not_found}, not an exception
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/193_subscription_weekly_usage_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users and subscriptions. Never run it against production.
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
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
is_error() { case "$1" in *ERROR*|*"operator does not exist"*) return 0;; *) return 1;; esac; }

TODAY=$(su -c "select public._studio_today_date()")
n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); CO=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f193-$n-m@t.local', '081$n'), ('$CO'::uuid, 'f193-$n-c@t.local', '082$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$CO');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$CO'" >/dev/null

# Subscription starting on an explicit date, with a 'group' weekly_limit of 2 -- returns SUB/A via globals.
mksub_from() {
  local start="$1" an; an=$(date +%s%N | tail -c 9)
  A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f193-$an-a@t.local', jsonb_build_object('full_name','a193','phone','083$an','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  R=$(api "$M" "select public.create_subscription('$A', false, 300, '$start', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
  case "$R" in *'"ok" : true'*) :;; *) fail "mksub_from($start): $R"; echo "193 ABORTED"; exit 1;; esac
  SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false and deleted_at is null order by created_at desc limit 1")
}

echo "== A: a subscription starting on a SUNDAY -- exactly the reported production scenario"
SUNDAY=$(su -c "select (date '$TODAY') - extract(dow from date '$TODAY')::int")
expect "A sanity: computed date is actually a Sunday" "0" "$(su -c "select extract(dow from date '$SUNDAY')::int")"
mksub_from "$SUNDAY"
R=$(api "$M" "select public.get_subscription_weekly_usage('$SUB', '$SUNDAY')::text;")
if is_error "$R"; then fail "A RPC raised an error instead of returning JSON: $(echo "$R" | head -1 | cut -c1-200)"; else
  expect "A ok:true for a Sunday-start subscription's first week" "true" "$(jf "$R" ok)"
  expect "A week_start matches the Sunday" "$SUNDAY" "$(jf "$R" week_start)"
fi

echo "== B: a subscription starting MID-WEEK (Wednesday)"
WEDNESDAY=$(su -c "select (date '$SUNDAY') + 3")
expect "B sanity: computed date is actually a Wednesday" "3" "$(su -c "select extract(dow from date '$WEDNESDAY')::int")"
mksub_from "$WEDNESDAY"
R=$(api "$M" "select public.get_subscription_weekly_usage('$SUB', '$WEDNESDAY')::text;")
if is_error "$R"; then fail "B RPC raised an error instead of returning JSON: $(echo "$R" | head -1 | cut -c1-200)"; else
  expect "B ok:true for a mid-week-start subscription" "true" "$(jf "$R" ok)"
  expect "B week_start normalizes to the Sunday of that week" "$SUNDAY" "$(jf "$R" week_start)"
fi

echo "== C: response structure and values"
expect "C week_end is 6 days after week_start" "$(su -c "select (date '$SUNDAY') + 6")" "$(jf "$R" week_end)"
expect "C usage[0].tier is group" "group" "$(jf "$R" "usage,0,tier")"
expect "C usage[0].configured_weekly_limit matches the allowance given at creation" "2" "$(jf "$R" "usage,0,configured_weekly_limit")"
expect "C usage[0].used is 0 (no registrations yet)" "0" "$(jf "$R" "usage,0,used")"
expect "C usage[0].extra is 0" "0" "$(jf "$R" "usage,0,extra")"
# The subscription in $R started on the Wednesday of this week (dow=3), so only Wed-Fri (3 of the 6
# Sun-Fri studio-week days) fall inside its plan window -- a correctly prorated partial first week,
# not a bug. subscription_effective_context (unchanged, untouched by this fix) owns that math.
expect "C window_days reflects the prorated partial first week (started Wednesday: Wed-Fri = 3 days)" "3" "$(jf "$R" window_days)"
expect "C active_days matches window_days (no freeze in effect)" "3" "$(jf "$R" active_days)"
expect "C frozen_days is present" "0" "$(jf "$R" frozen_days)"

echo "== D: unauthorized access"
anon_out=$(api_as "anon" "" "select public.get_subscription_weekly_usage('$SUB', '$WEDNESDAY')::text;")
if is_error "$anon_out"; then fail "D anon call raised an error instead of a clean forbidden JSON: $(echo "$anon_out" | head -1 | cut -c1-160)"; else
  expect "D anon reaches the function and gets ok:false" "false" "$(jf "$anon_out" ok)"
  expect "D anon gets error:forbidden (not an exception)" "forbidden" "$(jf "$anon_out" error)"
fi
athlete_out=$(api_as "authenticated" "$A" "select public.get_subscription_weekly_usage('$SUB', '$WEDNESDAY')::text;")
expect "D the subscription's own athlete (non-manager) is refused" "forbidden" "$(jf "$athlete_out" error)"

echo "== E: a nonexistent subscription"
FAKE=$(su -c "select gen_random_uuid()")
R=$(api "$M" "select public.get_subscription_weekly_usage('$FAKE', '$WEDNESDAY')::text;")
if is_error "$R"; then fail "E raised an error instead of a clean not-found JSON: $(echo "$R" | head -1 | cut -c1-160)"; else
  expect "E nonexistent subscription returns subscription_not_found, not an exception" "subscription_not_found" "$(jf "$R" error)"
fi

echo
echo "193 subscription weekly usage: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
