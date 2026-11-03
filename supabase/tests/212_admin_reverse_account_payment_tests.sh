#!/usr/bin/env bash
# Operator-run payment reversal: only an owner connection, right row only, row and audit kept, other payments untouched.
# Usage: PSQL=... supabase/tests/212_admin_reverse_account_payment_tests.sh   (LOCAL stack only, commits fixtures)
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
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t212-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role' where user_id='$id'" >/dev/null
  echo "$id"; }
err() { sed -n 's/.*"error": "\([a-z_]*\)".*/\1/p; s/.*"ok": true.*/ok/p' | head -1; }
bal() { su -c "select outstanding_ils from public._period_merged_athlete_finance('2000-01-01','2100-01-01') where kind='app' and pid='$1'"; }
pay() { su -c "insert into public.athlete_account_payments (payee_id,payee_is_manual,amount_ils,payment_method,paid_at,created_by) values ('$1',false,$2,'other',$3,'$MGR') returning id"; }
call() { su -c "select public.admin_reverse_account_payment('$1','$2','$3','$4',$5,$6)" | err; }

MGR=$(new_user manager); COACH=$(new_user coach); A=$(new_user athlete); OPERATOR="Test operator"
S=$(su -c "insert into public.training_sessions (session_date,start_time,coach_id,max_participants,custom_slot_price_ils) values (current_date-3,'10:00','$COACH',10,730) returning id")
su -c "insert into public.session_registrations (session_id,user_id,status,attended) values ('$S','$A','active',true)" >/dev/null
D=$(su -c "select (current_date + 60)::text")
GOOD=$(pay "$A" 570 "current_date - 2"); DUP=$(pay "$A" 570 "'$D'::date")
expect "with both payments" -410.00 "$(bal "$A")"
GOODSUM=$(su -c "select md5(row(amount_ils,paid_at,payment_method,reversed_at,reversed_by)::text) from public.athlete_account_payments where id='$GOOD'")

echo "--- who can call it"
for ROLE in anon authenticated service_role; do
  expect "$ROLE has no access" f "$(su -c "select has_function_privilege('$ROLE','public.admin_reverse_account_payment(uuid,text,uuid,text,numeric,date)','execute')")"
done
expect "a signed-in manager is refused access" 1 "$(as "$MGR" "select public.admin_reverse_account_payment('$DUP','x y z','$MGR','someone',570,'$D'::date)" | grep -c "permission denied")"
expect "inside a user session it refuses even for the owner" not_for_user_sessions "$(echo "begin; set local request.jwt.claims = '{\"sub\":\"$MGR\"}'; select public.admin_reverse_account_payment('$DUP','x y z','$MGR','someone',570,'$D'::date); commit;" | $PSQL -qAt -f - 2>&1 | err)"

echo "--- refusals"
expect "a reason is required" reason_required "$(call "$DUP" "  " "$MGR" "$OPERATOR" 570 "'$D'::date")"
expect "who performed it is required" performed_by_required "$(call "$DUP" "x y z" "$MGR" " " 570 "'$D'::date")"
expect "the authoriser must be a manager" authorizer_not_manager "$(call "$DUP" "x y z" "$COACH" "$OPERATOR" 570 "'$D'::date")"
expect "the wrong amount stops it" payment_does_not_match "$(call "$DUP" "x y z" "$MGR" "$OPERATOR" 571 "'$D'::date")"
expect "the wrong date stops it" payment_does_not_match "$(call "$DUP" "x y z" "$MGR" "$OPERATOR" 570 "current_date")"
expect "an unknown payment" not_found "$(call "$(su -c "select gen_random_uuid()")" "x y z" "$MGR" "$OPERATOR" 570 "'$D'::date")"
expect "nothing changed so far" -410.00 "$(bal "$A")"

echo "--- reversal"
expect "it reverses" ok "$(call "$DUP" "Duplicate entry" "$MGR" "$OPERATOR" 570 "'$D'::date")"
expect "the balance excludes it" 160.00 "$(bal "$A")"
expect "the row and its original values are kept" "570.00|$D" "$(su -c "select amount_ils||'|'||paid_at from public.athlete_account_payments where id='$DUP'")"
expect "reversed_by holds the authorising manager" "$MGR" "$(su -c "select reversed_by from public.athlete_account_payments where id='$DUP'")"
expect "the other payment is untouched" "$GOODSUM" "$(su -c "select md5(row(amount_ils,paid_at,payment_method,reversed_at,reversed_by)::text) from public.athlete_account_payments where id='$GOOD'")"
expect "exactly one active payment remains" 1 "$(su -c "select count(*) from public.athlete_account_payments where payee_id='$A' and reversed_at is null")"
E_="from public.user_activity_events where target_id='$DUP' and event_type='account_payment_reversed'"
expect "one audit event" 1 "$(su -c "select count(*) $E_")"
expect "no signed-in actor is claimed" t "$(su -c "select actor_user_id is null $E_")"
expect "the event has the reason" "Duplicate entry" "$(su -c "select metadata->>'reason' $E_")"
expect "the event names who performed it" "$OPERATOR" "$(su -c "select metadata->>'performed_by' $E_")"
expect "the event names who authorised it" "$MGR" "$(su -c "select metadata->>'authorized_by' $E_")"
expect "the original creation event stays" 1 "$(su -c "select count(*) from public.user_activity_events where target_id='$DUP' and event_type='account_payment_created'")"

echo "--- afterwards"
expect "reversing twice is refused" already_reversed "$(call "$DUP" "again" "$MGR" "$OPERATOR" 570 "'$D'::date")"
expect "a reversed payment cannot be deleted" 1 "$(as "$MGR" "delete from public.athlete_account_payments where id='$DUP'" | grep -c account_payment_reversed_immutable)"
X=$(pay "$A" 5 current_date)
expect "the guard still blocks a direct reversal" 1 "$(as "$MGR" "update public.athlete_account_payments set reversed_at=now(), reversed_by='$MGR' where id='$X'" | grep -c unauthorized_payment_reversal)"
expect "the switch is off in a new transaction" "" "$(su -c "select current_setting('shira.allow_payment_reversal', true)")"
RC=$(new_user athlete); SUB=$(su -c "insert into public.subscriptions (payee_id,payee_is_manual) values ('$RC',false) returning id")
L=$(su -c "insert into public.athlete_account_payments (payee_id,payee_is_manual,amount_ils,payment_method,paid_at,source_subscription_id) values ('$RC',false,10,'cash',current_date,'$SUB') returning id")
expect "a subscription-linked payment is refused" linked_to_subscription "$(call "$L" "x y z" "$MGR" "$OPERATOR" 10 "current_date")"
expect "the manager function still works" ok "$(as "$MGR" "select public.manager_reverse_account_payment('$X','x y z')" | err)"

echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
