#!/usr/bin/env bash
# Reversing a mistaken account payment: excluded from totals, row and audit kept, sibling payments untouched.
# Usage: PSQL=... supabase/tests/211_manager_reverse_account_payment_tests.sh   (LOCAL stack only, commits fixtures)
set -u
PSQL=${PSQL:?set PSQL}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@" </dev/null; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
as() { local uid=$1; shift
  echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}'; $*; commit;" \
    | $PSQL -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
new_user() { local role=$1 id; id=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t211-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role' where user_id='$id'" >/dev/null
  echo "$id"; }
err() { sed -n 's/.*"error": "\([a-z_]*\)".*/\1/p; s/.*"ok": true.*/ok/p' | head -1; }
bal() { su -c "select outstanding_ils from public._period_merged_athlete_finance('2000-01-01','2100-01-01') where kind='app' and pid='$1'"; }
pay() { su -c "insert into public.athlete_account_payments (payee_id,payee_is_manual,amount_ils,payment_method,paid_at,created_by) values ('$1',false,$2,'other',$3,'$MGR') returning id"; }

MGR=$(new_user manager); COACH=$(new_user coach); A=$(new_user athlete)
S=$(su -c "insert into public.training_sessions (session_date,start_time,coach_id,max_participants,custom_slot_price_ils) values (current_date-3,'10:00','$COACH',10,730) returning id")
su -c "insert into public.session_registrations (session_id,user_id,status,attended) values ('$S','$A','active',true)" >/dev/null
GOOD=$(pay "$A" 570 "current_date - 2"); DUP=$(pay "$A" 570 "current_date + 60")
expect "with both payments" -410.00 "$(bal "$A")"
BEFORE_GOOD=$(su -c "select md5(row(amount_ils,paid_at,payment_method,reversed_at)::text) from public.athlete_account_payments where id='$GOOD'")
EVENTS=$(su -c "select count(*) from public.user_activity_events where target_id='$DUP'")

expect "an athlete cannot" forbidden "$(as "$A" "select public.manager_reverse_account_payment('$DUP','x y z')" | err)"
expect "a coach cannot" forbidden "$(as "$COACH" "select public.manager_reverse_account_payment('$DUP','x y z')" | err)"
expect "a reason is required" reason_required "$(as "$MGR" "select public.manager_reverse_account_payment('$DUP','  ')" | err)"
expect "an unknown payment" not_found "$(as "$MGR" "select public.manager_reverse_account_payment(gen_random_uuid(),'x y z')" | err)"
expect "nothing changed so far" -410.00 "$(bal "$A")"
expect "anon has no access" f "$(su -c "select has_function_privilege('anon','public.manager_reverse_account_payment(uuid,text)','execute')")"

expect "a manager can reverse it" ok "$(as "$MGR" "select public.manager_reverse_account_payment('$DUP','duplicate entry')" | err)"
expect "the balance excludes it" 160.00 "$(bal "$A")"
expect "the row is kept" 1 "$(su -c "select count(*) from public.athlete_account_payments where id='$DUP'")"
expect "its original values are kept" "570.00|$(su -c "select (current_date + 60)::text")" "$(su -c "select amount_ils||'|'||paid_at from public.athlete_account_payments where id='$DUP'")"
expect "who reversed it is recorded" "$MGR" "$(su -c "select reversed_by from public.athlete_account_payments where id='$DUP'")"
expect "the other payment is untouched" "$BEFORE_GOOD" "$(su -c "select md5(row(amount_ils,paid_at,payment_method,reversed_at)::text) from public.athlete_account_payments where id='$GOOD'")"
expect "exactly one active payment remains" 1 "$(su -c "select count(*) from public.athlete_account_payments where payee_id='$A' and reversed_at is null")"
expect "the audit event has the reason" "duplicate entry" "$(su -c "select metadata->>'reason' from public.user_activity_events where target_id='$DUP' and event_type='account_payment_reversed'")"
expect "the original creation event stays" "$EVENTS" "$(su -c "select count(*) from public.user_activity_events where target_id='$DUP' and event_type<>'account_payment_reversed'")"
expect "reversing twice is refused" already_reversed "$(as "$MGR" "select public.manager_reverse_account_payment('$DUP','again')" | err)"
expect "a reversed payment still cannot be deleted" 1 "$(as "$MGR" "delete from public.athlete_account_payments where id='$DUP'" | grep -c account_payment_reversed_immutable)"
X=$(pay "$A" 5 current_date)
expect "the guard still blocks a direct reversal" 1 "$(as "$MGR" "update public.athlete_account_payments set reversed_at=now() where id='$X'" | grep -c unauthorized_payment_reversal)"
RC=$(new_user athlete); SUB=$(su -c "insert into public.subscriptions (payee_id,payee_is_manual) values ('$RC',false) returning id")
L=$(su -c "insert into public.athlete_account_payments (payee_id,payee_is_manual,amount_ils,payment_method,source_subscription_id) values ('$RC',false,10,'cash','$SUB') returning id" 2>/dev/null)
[ -n "$L" ] && expect "a subscription-linked payment is refused" linked_to_subscription "$(as "$MGR" "select public.manager_reverse_account_payment('$L','x y z')" | err)"
echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
