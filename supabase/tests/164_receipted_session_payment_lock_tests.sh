#!/usr/bin/env bash
# Regression test for 20261013140000_lock_receipted_session_payments_for_coaches.sql, updated by
# 20261020140000_remove_manager_exemption_session_payment_guard.sql (owner policy, 2026-10-20: once a receipt
# has been issued, NO ONE -- including managers -- may modify or delete that payment while the receipt is active).
#
# Real `authenticator` connections as authenticated users with JWT claims (one transaction per call, like PostgREST).
# Fixture: manager M, coach C (owns S1), athlete A registered to S1, manual participant MP on S1.
#   F  coach manages payments freely while NO receipt exists (record, correct, mark unpaid) through the attendance RPCs;
#      direct table updates of walk-in rows are manager-only since 20261020100000 (session configuration lockdown)
#   L  after a receipt is issued for that payment, NEITHER the coach NOR the manager can change amount / method / mark
#      unpaid / no-show charge, or update the manual participant's payment directly, or remove the participant or move
#      them, while attendance-only changes still pass; the lock RPC reports the locked rows the same way for both roles
#      (manager exemption removed by the receipt-hardening release, owner policy 2026-10-20 -- a separate, later change
#      from the same-day session-configuration lockdown above)
#   X  an externally-marked receipt locks the same way; cancelling the receipt unlocks it for everyone again
#   C  concurrency: a receipt being issued in a concurrent transaction cannot be bypassed (the coach waits, then is refused)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/164_receipted_session_payment_lock_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
api() { local uid=$1; shift
  { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
allowed() { case "$2" in *payment_locked_receipt_issued*|*session_payment_has_receipt_history*|*forbidden*|*ERROR*) fail "$1: $(echo "$2" | grep -m1 -E 'ERROR|forbidden' | cut -c1-150)";; *) ok "$1";; esac; }
locked()  { case "$2" in *payment_locked_receipt_issued*|*session_payment_has_receipt_history*) ok "$1 (refused: receipt issued)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-150)";; esac; }
pay() { su -c "select coalesce(payment_method,'-') || '/' || coalesce(amount_paid::text,'-') || '/' || charge_no_show from public.$1 where id = '$2'"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f164-$n-m@t.local', '091$n'), ('$C'::uuid, 'f164-$n-c@t.local', '092$n'), ('$A'::uuid, 'f164-$n-a@t.local', '093$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date - 1, '07:45', '$C', 6, true) returning id" | head -1)
S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 3, '07:45', '$C', 6, true) returning id" | head -1)
REG=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$S1', '$A', 'active') returning id" | head -1)
MPID=$(su -c "insert into public.manual_participants (full_name, phone) values ('mp164 $n', '094$n') returning id" | head -1)
SMP=$(su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S1', '$MPID') returning id" | head -1)
attend() { api "$1" "select public.set_registration_attendance('$S1', '$A', '$2', $3, $4, false)::text;"; }
attendm() { api "$1" "select public.set_manual_participant_attendance('$S1', '$MPID', '$2', $3, $4, false)::text;"; }

echo "== F: no receipt -> coach manages payments"
allowed "F coach records arrival + cash 60" "$(attend $C arrived "'cash'" 60)"
allowed "F coach corrects the payment (bit 70)" "$(attend $C arrived "'bit'" 70)"
allowed "F coach marks it unpaid" "$(attend $C arrived null null)"
allowed "F coach records it again (cash 60)" "$(attend $C arrived "'cash'" 60)"
expect "F payment saved" "cash/60.00/false" "$(pay session_registrations $REG)"
allowed "F coach records manual participant payment (RPC)" "$(attendm $C arrived "'cash'" 50)"
# Since 20261020100000_coach_session_configuration_manager_only.sql a coach writes walk-in rows only through the RPCs
# (which validate and log every payment change); a direct table update matches no row.
expect "F coach can't correct the manual payment by direct table update (0 rows)" "0" "$(api $C "with u as (update public.session_manual_participants set amount_paid = 55 where id = '$SMP' returning 1) select count(*) from u;")"
allowed "F coach corrects manual participant payment (RPC)" "$(attendm $C arrived "'cash'" 55)"
expect "F manual payment saved" "cash/55.00/false" "$(pay session_manual_participants $SMP)"
expect "F lock RPC: nothing locked yet" '{"ok" : true, "locked_user_ids" : [], "locked_manual_ids" : []}' "$(api $C "select public.session_payment_receipt_locks('$S1')::text;")"

echo "== L: receipt issued -> read-only for the coach"
R=$(api "$M" "select public.create_document(60, 'other', 'Customer 164', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "L manager issues a receipt for the registration payment";; *) fail "L issue receipt: $R";; esac
DOCR=$(su -c "select id from public.documents where source_id = '$REG' and status <> 'CANCELLED' limit 1")
locked "L coach changes the amount" "$(attend $C arrived "'cash'" 80)"
locked "L coach changes the method" "$(attend $C arrived "'bit'" 60)"
locked "L coach marks it unpaid" "$(attend $C arrived null null)"
locked "L coach marks absent (clears the payment)" "$(api $C "select public.set_registration_attendance('$S1', '$A', 'absent', null, null, false)::text;")"
api $C "select public.set_registration_attendance('$S1', '$A', 'arrived', 'cash', 60, true)::text;" >/dev/null  # no-show flag is ignored while arrived
expect "L a no-show flag on an arrived row changes nothing" "cash/60.00/false" "$(pay session_registrations $REG)"
expect "L payment unchanged after refused attempts" "cash/60.00/false" "$(pay session_registrations $REG)"
allowed "L attendance-only re-save with the same payment still passes" "$(attend $C arrived "'cash'" 60)"
R=$(api "$M" "select public.mark_payment_receipt_external('session_manual:$SMP', 'paper receipt')::text;")
case "$R" in *'"ok" : true'*) ok "X manager marks the manual participant's payment as receipted externally";; *) fail "X mark external: $R";; esac
locked "X coach changes the manual payment via RPC" "$(attendm $C arrived "'bit'" 55)"
expect "X coach changes the manual payment directly (table update): no row (RLS, since 20261020100000)" "0" "$(api $C "with u as (update public.session_manual_participants set amount_paid = 1 where id = '$SMP' returning 1) select count(*) from u;")"
locked "X coach removes the receipted manual participant" "$(api $C "select public.remove_manual_participant_from_session('$S1', '$MPID')::text;")"
S3=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 4, '07:45', '$C', 6, true) returning id" | head -1)
MP3=$(su -c "insert into public.manual_participants (full_name, phone) values ('mp164b $n', '096$n') returning id" | head -1)
SMP3=$(su -c "insert into public.session_manual_participants (session_id, manual_participant_id, attended, payment_method, amount_paid) values ('$S3', '$MP3', true, 'cash', 40) returning id" | head -1)
api "$M" "select public.mark_payment_receipt_external('session_manual:$SMP3', 'paper')::text;" >/dev/null
R=$(api $C "select public.staff_move_session_participant('$S3', '$S2', null, '$MP3', false, false, false, false)::text;")
case "$R" in *payment_locked_receipt_issued*|*roster_locked*) ok "X coach cannot move a receipted participant (move refuses any paid row: roster_locked)";; *) fail "X move: $R";; esac
expect "X moved participant still on the original session with its payment" "cash/40.00/false" "$(pay session_manual_participants $SMP3)"
expect "X manual payment unchanged" "cash/55.00/false" "$(pay session_manual_participants $SMP)"
R=$(api $C "select public.session_payment_receipt_locks('$S1')::text;")
case "$R" in *"$A"*"$MPID"*) ok "L lock RPC reports both locked rows to the session's coach";; *) fail "L lock RPC: $R";; esac
C2=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('$C2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f164-$n-c2@t.local', jsonb_build_object('full_name','c2','phone','095$n','gender','female','address','A','zip_code','1'), now(), now()); update public.profiles set approval_status='approved', role='coach' where user_id='$C2'" >/dev/null
case "$(api $C2 "select public.session_payment_receipt_locks('$S1')::text;")" in *forbidden*) ok "L lock RPC refused to another coach";; *) fail "L lock RPC other coach";; esac
locked "L manager is ALSO refused (policy 2026-10-20: no exemption for anyone)" "$(attend $M arrived "'cash'" 65)"
expect "L payment unchanged after the manager's refused attempt" "cash/60.00/false" "$(pay session_registrations $REG)"

echo "== X: cancelling the receipt unlocks"
R=$(api "$M" "select public.cancel_document('$DOCR', 'test 164', false)::text;")
case "$R" in *'"ok" : true'*) ok "X manager cancels the receipt";; *) fail "X cancel receipt: $R";; esac
allowed "X coach can change the payment again after cancellation" "$(attend $C arrived "'bit'" 66)"

echo "== C: concurrent receipt issuance cannot be bypassed"
REG2=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S2', '$A', 'active', true, 'cash', 60) returning id" | head -1)
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.create_document(60, 'other', 'Customer 164', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG2', 'cash');
    select pg_sleep(3); commit;"; } | $PSQL_AUTH -qAt > /tmp/164_issue.log 2>&1 ) &
sleep 1
OUT=$(api $C "update public.session_registrations set amount_paid = 1 where id = '$REG2'; select 1;" 2>&1)
OUT2=$(api $C "select public.set_registration_attendance('$S2', '$A', 'arrived', 'bit', 1, false)::text;" 2>&1)
wait
case "$OUT2" in *payment_locked_receipt_issued*) ok "C coach's change issued while the receipt was being created waits, then is refused";; *) fail "C concurrent: $(echo "$OUT2" | head -1 | cut -c1-150)";; esac
expect "C payment unchanged after the race" "cash/60.00/false" "$(pay session_registrations $REG2)"
expect "C exactly one receipt for the payment" "1" "$(su -c "select count(*) from public.documents where source_id = '$REG2' and status <> 'CANCELLED'")"

echo
echo "164 receipted session payment lock: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
