#!/usr/bin/env bash
# The policy choices reviewed by the owner on 2026-11-03: paid over-quota sessions, the stop date, penalties.
# Fixtures are isolated. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"

echo "== 3.1: when a slot frees up, by state of the over-quota session"
three() { mkuser athlete; A=$U; mksub "$A" "$TODAY" 1; mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; }
three; mark "$R1" false false
expect "unpaid: reconsidered, becomes covered" "true:" "$(cov "$R2")"
three; su -c "update public.session_registrations set amount_paid=50,payment_method='cash' where id='$R2'" >/dev/null; mark "$R1" false false
expect "paid, no receipt: keeps its price" "false:paid_at_regular_price" "$(cov "$R2")"
expect "the slot stays free for the next booking" "1" "$(su -c "select e->>'effective_weekly_limit' from jsonb_array_elements(public._subscription_week_usage('$SUB','$A',false,'$(wk 1 0)',array['group']::public.subscription_tier[])) e")"
expect "used is 0: the money did not consume allowance" "0" "$(su -c "select e->>'used' from jsonb_array_elements(public._subscription_week_usage('$SUB','$A',false,'$(wk 1 0)',array['group']::public.subscription_tier[])) e")"
mksession "$(wk 1 2)"; S3=$SX; register "$A" "$S3"; R3=$REG
expect "the next booking gets it" "true:" "$(cov "$R3")"
LEDGER_AMOUNT=$(su -c "select amount_paid from public.session_registrations where id='$R2'")
expect "no credit or refund was made" "50.00|0" "$LEDGER_AMOUNT|$(su -c "select count(*) from public.athlete_account_payments where payee_id='$A'")"
three; su -c "update public.session_registrations set amount_paid=50,payment_method='cash' where id='$R2'; insert into public.external_manual_receipts(row_kind,record_id,note) values ('session_reg','$R2','t')" >/dev/null; mark "$R1" false false
expect "receipted: keeps its price" "false:paid_at_regular_price" "$(cov "$R2")"

echo "== 3.3: sessions on the stop date, against deleting"
mkuser athlete; A=$U; mksub "$A" "$(d -20)" 2; W=$(su -c "select date '$TODAY' - extract(dow from date '$TODAY')::int")
ver=$VER
mksession "$TODAY" 8 "00:05"; S1=$SX
su -c "update public.training_sessions set duration_minutes=1 where id='$S1'" >/dev/null
past_reg "$A" "$S1" true; R1=$REG
su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$ver','$R1','$TODAY','$W','group',true,'registration')" >/dev/null
mksession "$(d -3)"; S0=$SX; past_reg "$A" "$S0" true; R0=$REG
W0=$(su -c "select date '$(d -3)' - extract(dow from date '$(d -3)')::int")
su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$ver','$R0','$(d -3)','$W0','group',true,'registration')" >/dev/null
mksession "$(wk 1 1)"; SF=$SX; register "$A" "$SF"; RF=$REG
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$TODAY',true,'charge_regular_price',ARRAY['$RF']::uuid[],ARRAY[]::uuid[])::text;")
expect "only the future booking is resolved" "1" "$(jf "$R" future_registrations_resolved)"
expect "before the stop: stays covered" "true:" "$(cov "$R0")"
expect "on the stop date, already over: stays covered" "true:" "$(cov "$R1")"
expect "future: regular price" "false:subscription_ended" "$(cov "$RF")"
mark "$R1" false true; mark "$R1" true
expect "a later attendance edit keeps it" "true:" "$(cov "$R1")"

mkuser athlete; A=$U; mksub "$A" "$(d -20)" 2; mksession "$(d -3)"; S0=$SX; past_reg "$A" "$S0" true; R0=$REG
su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$R0','$(d -3)','$W0','group',true,'registration')" >/dev/null
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;")
api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$(jf "$R" fingerprint)');" >/dev/null
expect "deleting the same history moves it to regular price" "false:subscription_deleted" "$(cov "$R0")"

echo "== 3.6: the Limor Weizman pattern, as an isolated manual-participant fixture"
mkmanual; R=$(api "$M" "select public.create_subscription('$MP',true,360,'$TODAY',null,null,jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;"); SUB=$(jf "$R" subscription_id)
W=$(wk 1 0); mksession "$W"; A1=$SX; mksession "$(wk 1 2)"; A2=$SX; mksession "$(wk 1 4)"; A3=$SX
su -c "update public.training_sessions set custom_slot_price_ils=50 where id in ('$A1','$A2','$A3')" >/dev/null
SM1=$(su -c "insert into public.session_manual_participants(session_id,manual_participant_id,added_at) values ('$A1','$MP',now()-interval '3 min') returning id" | head -1)
SM3=$(su -c "insert into public.session_manual_participants(session_id,manual_participant_id,added_at) values ('$A3','$MP',now()-interval '2 min') returning id" | head -1)
SM2=$(su -c "insert into public.session_manual_participants(session_id,manual_participant_id,added_at) values ('$A2','$MP',now()-interval '1 min') returning id" | head -1)
su -c "select public.subscription_reconcile_week('$SUB','$W','group')" >/dev/null
su -c "update public.session_manual_participants set attended=false, charge_no_show=true where id in ('$SM1','$SM2')" >/dev/null
expect "charged no-show within the allowance: spends the slot" "true:" "$(covm "$SM1")"
expect "charged no-show over quota: regular price" "false:allowance_exceeded" "$(covm "$SM2")"
expect "the third keeps its covered slot" "true:" "$(covm "$SM3")"
expect "the penalty consumes allowance" "2" "$(su -c "select e->>'used' from jsonb_array_elements(public._subscription_week_usage('$SUB','$MP',true,'$W',array['group']::public.subscription_tier[])) e")"
FIN() { su -c "select expected_ils from public._period_merged_athlete_finance('$W','$(wk 1 6)') where pid='$MP'"; }
expect "only the over-quota penalty is owed (plus any charge in the week)" "50.00" "$(FIN)"
echo "   -- a covered booking is removed without a penalty"
api "$M" "select public.remove_manual_participant_from_session('$A3','$MP');" >/dev/null
expect "the over-quota penalty does not become free" "false:allowance_exceeded" "$(covm "$SM2")"
expect "still owed" "50.00" "$(FIN)"

echo "== 3.6: same for an app athlete, with a charged late cancellation over quota"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1; mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
su -c "update public.session_registrations set status='cancelled' where id='$R2'; insert into public.cancellations(session_id,user_id,charged_full_price,reason) values ('$S2','$A',true,'t')" >/dev/null
expect "charged cancellation over quota: regular price" "false:allowance_exceeded" "$(cov "$R2")"
su -c "update public.session_registrations set status='cancelled' where id='$R1'; insert into public.cancellations(session_id,user_id,charged_full_price,reason) values ('$S1','$A',false,'t')" >/dev/null
expect "stays charged when the covered one is cancelled free" "false:allowance_exceeded" "$(cov "$R2")"
finish
