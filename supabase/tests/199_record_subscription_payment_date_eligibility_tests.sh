#!/usr/bin/env bash
# Regression suite for 20261029220000 (record_subscription_payment date-eligibility check).
#
# record_subscription_payment previously only checked that the subscription row existed --
# nothing stopped a payment from being linked to a subscription dated after it had already
# stopped or run past its plan_end_date. This is the server-side half of the new
# AddAccountPaymentModal "this is a subscription payment" toggle (mobile), which now only offers
# the option when its own client-side replica of this same rule says the subscription is eligible
# as of the selected paid_at date -- this suite proves the backend refuses it independently of
# whatever the client did or didn't check.
#
# Scenarios
#   A  a payment dated while the subscription is active succeeds and is linked
#   B  a payment dated ON/AFTER stopped_effective_date is refused (subscription_not_eligible_for_date)
#   C  a payment dated BEFORE the stop date (even though the subscription is stopped as of today)
#      still succeeds -- eligibility is evaluated as of paid_at, not "today"
#   D  a payment dated after plan_end_date is refused
#   E  a payment dated during an active freeze still succeeds -- a freeze pauses billing/coverage,
#      it does not end the relationship
#   F  an ADVANCE payment dated before plan_start_date succeeds -- the subscription hasn't started
#      yet as of that date, which is a legitimate, already-relied-upon case (not "inactive"; see
#      189_subscription_delete_payment_guard_tests.sh scenarios 3/4, which record a same-day
#      payment against a subscription whose plan_start_date is the next day)
#   G  a nonexistent subscription_id still returns subscription_not_found, unchanged
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/199_record_subscription_payment_date_eligibility_tests.sh
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

TODAY=$(su -c "select public._studio_today_date()")
d() { su -c "select (date '$TODAY' + $1)::date"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
  ('$M','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f199-$n-m@t.local', jsonb_build_object('full_name','m199','phone','091$n','gender','female','address','A','zip_code','1'), now(), now());
  update public.profiles set approval_status='approved' where user_id='$M';
  update public.profiles set role='manager' where user_id='$M'" >/dev/null

mksub() { # start_date, returns SUB/VER via globals, and a FRESH athlete A each time
  local an; an=$(date +%s%N | tail -c 9)
  A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f199-$an-a@t.local', jsonb_build_object('full_name','a199','phone','092$an','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  R=$(api "$M" "select public.create_subscription('$A', false, 300, '$1', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
  case "$R" in *'"ok" : true'*) :;; *) fail "mksub: $R"; echo "199 ABORTED"; exit 1;; esac
  SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false and deleted_at is null order by created_at desc limit 1")
  VER=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB' and effective_to is null limit 1")
}
pay() { # subscription_id, paid_at -> R (raw RPC result)
  R=$(api "$M" "select public.record_subscription_payment('$1', 50, 'cash', null, null, '$2')::text;")
}

echo "== A: payment dated while active succeeds and is linked"
mksub "$(d -30)"
pay "$SUB" "$TODAY"
expect "A succeeds" "true" "$(jf "$R" ok)"
PID=$(jf "$R" payment_id)
expect "A payment is linked to the subscription" "$SUB" "$(su -c "select source_subscription_id from public.athlete_account_payments where id='$PID'")"

echo "== B: payment dated on/after stopped_effective_date is refused"
mksub "$(d -30)"
STOP=$(d -5)
api "$M" "select public.stop_subscription('$SUB', '$STOP', true)::text;" >/dev/null
pay "$SUB" "$STOP"
expect "B refused on the stop date itself" "false" "$(jf "$R" ok)"
expect "B error is subscription_not_eligible_for_date" "subscription_not_eligible_for_date" "$(jf "$R" error)"
pay "$SUB" "$(d -1)"
expect "B refused after the stop date too" "false" "$(jf "$R" ok)"

echo "== C: a payment dated BEFORE the stop date still succeeds, even though the subscription is stopped as of today"
mksub "$(d -30)"
STOP2=$(d -2)
api "$M" "select public.stop_subscription('$SUB', '$STOP2', true)::text;" >/dev/null
pay "$SUB" "$(d -10)"
expect "C succeeds for a date before the stop" "true" "$(jf "$R" ok)"

echo "== D: a payment dated after plan_end_date is refused"
mksub "$(d -60)"
END=$(d -10)
su -c "update public.subscription_versions set plan_end_date = '$END' where id = '$VER'" >/dev/null
pay "$SUB" "$(d -5)"
expect "D refused after plan_end_date" "false" "$(jf "$R" ok)"
expect "D error is subscription_not_eligible_for_date" "subscription_not_eligible_for_date" "$(jf "$R" error)"
pay "$SUB" "$(d -30)"
expect "D succeeds for a date within the plan window" "true" "$(jf "$R" ok)"

echo "== E: a payment dated during an active freeze still succeeds"
mksub "$(d -30)"
api "$M" "select public.freeze_subscription('$SUB', '$(d -5)', '$(d 5)', true)::text;" >/dev/null
pay "$SUB" "$TODAY"
expect "E succeeds while frozen" "true" "$(jf "$R" ok)"

echo "== F: an advance payment dated before plan_start_date succeeds (legitimate, not 'inactive')"
mksub "$(d 10)"
pay "$SUB" "$TODAY"
expect "F advance payment succeeds" "true" "$(jf "$R" ok)"
PID_F=$(jf "$R" payment_id)
expect "F advance payment is linked to the subscription" "$SUB" "$(su -c "select source_subscription_id from public.athlete_account_payments where id='$PID_F'")"

echo "== G: a nonexistent subscription_id still returns subscription_not_found"
R=$(api "$M" "select public.record_subscription_payment(gen_random_uuid(), 50, 'cash', null, null, '$TODAY')::text;")
expect "G subscription_not_found unchanged" "subscription_not_found" "$(jf "$R" error)"

echo
echo "199 record_subscription_payment date eligibility: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
