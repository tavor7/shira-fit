#!/usr/bin/env bash
# Verification of receipt cancellation / payment reversal against the new receipt-lock guards
# (20261020110000_guard_receipted_account_payments.sql, 20261020120000_guard_delete_receipted_sessions.sql,
# 20261020140000_remove_manager_exemption_session_payment_guard.sql). Traces the real transactional behavior of
# cancel_document / _revert_document_payment / _payment_has_active_document / _create_document_from_payment_row /
# create_documents_from_payments.
#
# Real `authenticator` connections. Fixture: manager M, coach C, athlete A with a session registration payment,
# a session manual-participant payment, and a standalone account payment.
#   A  cancel WITHOUT reverting (p_revert_payment=false): document -> CANCELLED (audit history kept), payment
#      UNCHANGED, and the payment is now editable again (correction/reissuance rules remain valid)
#   B  cancel WITH revert (p_revert_payment=true), for both a session payment (cleared in place) and an account
#      payment (hard-deleted by _revert_document_payment's own design) -- the new guards do NOT block either
#      revert (the document is cancelled first, in the same transaction, before the revert touches the payment);
#      no duplicate reversal on a retried cancel (already_cancelled); the original (cancelled) document is kept
#   C  correcting a payment after cancellation works (now unlocked); the historical (cancelled) document itself
#      is untouched by that correction -- it keeps recording what was true when it was issued
#   D  a replacement receipt can be issued for the same payment after cancellation; the original cancelled
#      document remains recorded; numbering is sequential; a SECOND active receipt for the same still-active
#      payment is blocked (document_already_exists)
#   E  concurrency: a receipt cancellation racing a payment edit, and a cancellation racing a second receipt
#      issuance attempt, cannot produce an inconsistent state
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/183_receipt_cancellation_reversal_scenarios_tests.sh (SCRATCH/LOCAL ONLY)
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
allowed() { case "$2" in *locked_receipt_issued*|*receipted_payment*|*ERROR*) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; *) ok "$1";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f183-$n-m@t.local', '031$n'), ('$C'::uuid, 'f183-$n-c@t.local', '032$n'), ('$A'::uuid, 'f183-$n-a@t.local', '033$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-183') where true" >/dev/null
DAY=$(su -c "select (current_date + 15)::text")

echo "== A: cancel WITHOUT reverting the payment"
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '06:00', '$C', 6, true) returning id" | head -1)
REG1=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S1', '$A', 'active', true, 'cash', 80) returning id" | head -1)
R=$(api "$M" "select public.create_document(80, 'other', 'Cust A', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "A manager issues a receipt";; *) fail "A issue: $R";; esac
DOC1=$(su -c "select id from public.documents where source_id = '$REG1' and status <> 'CANCELLED' limit 1")
DOC1NUM=$(su -c "select document_number from public.documents where id = '$DOC1'")
R=$(api "$M" "select public.cancel_document('$DOC1', 'test A no revert', false)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : false'*) ok "A cancel without revert succeeds, payment_reverted=false";; *) fail "A cancel: $R";; esac
STATUS1=$(su -c "select status from public.documents where id = '$DOC1'")
expect "A document is CANCELLED but kept (audit history)" "CANCELLED" "$STATUS1"
PAY1=$(su -c "select amount_paid::text || '/' || payment_method from public.session_registrations where id = '$REG1'")
expect "A payment UNCHANGED (no revert requested)" "80.00/cash" "$PAY1"
allowed "A the payment is now editable again (unlocked by cancellation)" "$(api "$M" "update public.session_registrations set amount_paid = 85 where id = '$REG1'; select 1;")"

echo "== B: cancel WITH revert -- session payment"
S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '07:00', '$C', 6, true) returning id" | head -1)
REG2=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S2', '$A', 'active', true, 'bit', 90) returning id" | head -1)
R=$(api "$M" "select public.create_document(90, 'other', 'Cust B', null, null, 'bit', 'svc', null, '$A', null, 'session_payment', '$REG2', 'bit')::text;")
case "$R" in *'"ok" : true'*) ok "B manager issues a receipt for the session payment";; *) fail "B issue: $R";; esac
DOC2=$(su -c "select id from public.documents where source_id = '$REG2' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOC2', 'test B revert', true)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : true'*) ok "B cancel WITH revert succeeds, payment_reverted=true (not blocked by the new guard)";; *) fail "B cancel: $R";; esac
PAY2=$(su -c "select coalesce(amount_paid::text,'NULL') || '/' || coalesce(payment_method,'NULL') from public.session_registrations where id = '$REG2'")
expect "B session payment fields cleared by the revert" "NULL/NULL" "$PAY2"
expect "B the original (cancelled) document is still recorded" "1" "$(su -c "select count(*) from public.documents where id = '$DOC2' and status = 'CANCELLED'")"
R=$(api "$M" "select public.cancel_document('$DOC2', 'retry', true)::text;")
case "$R" in *already_cancelled*) ok "B retried cancel is refused (already_cancelled) -- no duplicate reversal";; *) fail "B retry: $R";; esac

echo "== B: cancel WITH revert -- account payment (reversed_at status, 2026-10-21: row preserved, never deleted)"
PAY3=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 120, 'cash', current_date, '$M') returning id" | head -1)
R=$(api "$M" "select public.create_document(120, 'other', 'Cust B2', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY3', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "B manager issues a receipt for the account payment";; *) fail "B issue: $R";; esac
DOC3=$(su -c "select id from public.documents where source_id = '$PAY3' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOC3', 'test B2 revert', true)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : true'*) ok "B2 cancel WITH revert succeeds for the account payment (not blocked by the new guard)";; *) fail "B2 cancel: $R";; esac
expect "B2 the account payment row is PRESERVED (not deleted)" "1" "$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY3'")"
expect "B2 the original amount/method/date are untouched (full historical traceability)" "120.00/cash" "$(su -c "select amount_ils::text || '/' || payment_method from public.athlete_account_payments where id = '$PAY3'")"
expect "B2 the payment is now marked reversed_at" "true" "$(su -c "select (reversed_at is not null)::text from public.athlete_account_payments where id = '$PAY3'")"
expect "B2 the original (cancelled) document is still recorded, correctly referencing the still-existing payment" "1" "$(su -c "select count(*) from public.documents where id = '$DOC3' and status = 'CANCELLED' and source_id = '$PAY3'")"
R=$(api "$M" "select public.cancel_document('$DOC3', 'retry', true)::text;")
case "$R" in *already_cancelled*) ok "B2 retried cancel is refused (already_cancelled) -- no duplicate reversal";; *) fail "B2 retry: $R";; esac
expect "B2 reversed_at unchanged by the retried (refused) attempt" "true" "$(su -c "select (reversed_at is not null)::text from public.athlete_account_payments where id = '$PAY3'")"
R=$(api "$M" "select public.create_document(120, 'other', 'Cust B2 re-receipt attempt', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY3', 'cash')::text;")
case "$R" in *payment_reversed*) ok "B2 a reversed payment cannot be re-receipted (payment_reversed)";; *) fail "B2 re-receipt of reversed payment: $R";; esac
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY3' and reversed_at is null")
expect "B2 excluded from _period_merged_athlete_finance's collected total (reversed_at is null filter)" "0" "$N"

echo "== F: unified balance reflects the reversal exactly once"
PAIDAT=$(su -c "select paid_at::text from public.athlete_account_payments where id = '$PAY3'")
BAL_BEFORE_OTHER=$(su -c "select coalesce(sum(collected_account_ils),0)::text from public._period_merged_athlete_finance('$PAIDAT'::date, '$PAIDAT'::date) where pid = '$A'")
PAY4=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 75, 'cash', '$PAIDAT'::date, '$M') returning id" | head -1)
BAL_AFTER_SECOND_PAYMENT=$(su -c "select coalesce(sum(collected_account_ils),0)::text from public._period_merged_athlete_finance('$PAIDAT'::date, '$PAIDAT'::date) where pid = '$A'")
expect "F the reversed payment (120) contributes nothing; only the new unreversed one (75) counts" "75.00" "$BAL_AFTER_SECOND_PAYMENT"
R=$(api "$M" "select public.create_document(75, 'other', 'Cust F', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY4', 'cash')::text;")
DOCF=$(su -c "select id from public.documents where source_id = '$PAY4' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOCF', 'test F revert', true)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : true'*) ok "F second payment also reverses cleanly";; *) fail "F revert: $R";; esac
BAL_AFTER_SECOND_REVERT=$(su -c "select coalesce(sum(collected_account_ils),0::numeric(12,2))::text from public._period_merged_athlete_finance('$PAIDAT'::date, '$PAIDAT'::date) where pid = '$A'")
expect "F balance returns to the pre-both-payments baseline once both are reversed (reversed exactly once each, no double effect)" "0.00" "$BAL_AFTER_SECOND_REVERT"

echo "== C: correcting a payment after cancellation"
R2=$(api "$M" "update public.session_registrations set amount_paid = 85 where id = '$REG1'; select 1;")
case "$R2" in *ERROR*|*locked*) fail "C correction after cancellation: $R2";; *) ok "C correction after cancellation succeeds (already shown in A, re-confirmed)";; esac
DOC1_AFTER=$(su -c "select gross_amount::text from public.documents where id = '$DOC1'")
expect "C the historical (cancelled) document itself still reflects what was true when issued (unchanged by the later correction)" "80.00" "$DOC1_AFTER"

echo "== D: replacement receipt"
R=$(api "$M" "select public.create_document(85, 'other', 'Cust A replacement', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "D a replacement receipt can be issued for the same (now corrected) payment";; *) fail "D replacement: $R";; esac
DOC1B=$(su -c "select id from public.documents where source_id = '$REG1' and status <> 'CANCELLED' and id <> '$DOC1' limit 1")
DOC1BNUM=$(su -c "select document_number from public.documents where id = '$DOC1B'")
[ "$DOC1BNUM" \> "$DOC1NUM" ] && ok "D numbering is sequential ($DOC1NUM -> $DOC1BNUM)" || fail "D numbering: $DOC1NUM -> $DOC1BNUM"
expect "D the original cancelled document remains recorded" "1" "$(su -c "select count(*) from public.documents where id = '$DOC1' and status = 'CANCELLED'")"
# NOTE: the plain create_document(...) RPC used throughout this file is a freeform, non-integrated receipt-creation
# path with NO duplicate-receipt check of its own (confirmed by the prior read-only audit: that check lives only in
# create_document_with_payment / _create_document_from_payment_row, the integrated paths). This is a pre-existing,
# known architectural gap -- not introduced, changed, or worsened by this branch -- so the duplicate-prevention
# check below deliberately goes through create_document_with_payment(p_mode='session', ...), the real protected path.
R=$(api "$M" "select public.create_document_with_payment('session', 85, 'other', 'cash', 'Cust A dup', null, null, 'svc', null, '$A', null, '$S1', null, false)::text;")
case "$R" in *document_already_exists*) ok "D a SECOND active receipt for the same still-active payment is blocked (via the protected create_document_with_payment path)";; *) fail "D duplicate-active-receipt guard: $R";; esac

echo "== E: concurrency"
S3=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '08:00', '$C', 6, true) returning id" | head -1)
REG3=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S3', '$A', 'active', true, 'cash', 70) returning id" | head -1)
R=$(api "$M" "select public.create_document(70, 'other', 'Cust E', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG3', 'cash')::text;")
DOCE=$(su -c "select id from public.documents where source_id = '$REG3' and status <> 'CANCELLED' limit 1")
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.cancel_document('$DOCE', 'race', true);
    select pg_sleep(2); commit;"; } | $PSQL_AUTH -qAt > /tmp/183_cancel.log 2>&1 ) &
sleep 1
OUT=$(api "$C" "select public.set_registration_attendance('$S3', '$A', 'arrived', 'bit', 999, false)::text;" 2>&1)
wait
CANCELLED=$(su -c "select status from public.documents where id = '$DOCE'")
PAYFINAL=$(su -c "select coalesce(amount_paid::text,'NULL') || '/' || coalesce(payment_method,'NULL') from public.session_registrations where id = '$REG3'")
case "$OUT$CANCELLED$PAYFINAL" in
  *payment_locked_receipt_issued*CANCELLED*NULL/NULL*) ok "E coach's edit raced against cancellation and lost (payment ended up reverted, not double-written): $PAYFINAL" ;;
  *) echo "  INFO: E race resolved as OUT='$OUT' doc_status='$CANCELLED' payment='$PAYFINAL' (either ordering is consistent as long as no corruption)";;
esac
[ "$CANCELLED" = "CANCELLED" ] && ok "E the document ended up cancelled" || fail "E the document was not cancelled: $CANCELLED"
N=$(su -c "select count(*) from public.documents where source_id = '$REG3' and status <> 'CANCELLED'")
expect "E no duplicate active receipt resulted from the race" "0" "$N"

S4=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '09:00', '$C', 6, true) returning id" | head -1)
REG4=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S4', '$A', 'active', true, 'cash', 50) returning id" | head -1)
R=$(api "$M" "select public.create_document(50, 'other', 'Cust E2', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG4', 'cash')::text;")
DOCE2=$(su -c "select id from public.documents where source_id = '$REG4' and status <> 'CANCELLED' limit 1")
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.cancel_document('$DOCE2', 'race2', false);
    select pg_sleep(2); commit;"; } | $PSQL_AUTH -qAt > /tmp/183_cancel2.log 2>&1 ) &
sleep 1
OUT2=$(api "$M" "select public.create_document(50, 'other', 'Cust E2 dup attempt', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG4', 'cash')::text;" 2>&1)
wait
N2=$(su -c "select count(*) from public.documents where source_id = '$REG4' and status <> 'CANCELLED'")
[ "$N2" -le "1" ] && ok "E2 cancellation racing a second receipt-issuance attempt never leaves 2 active receipts (= $N2)" || fail "E2 ended up with $N2 active receipts for the same payment"

echo
echo "183 receipt cancellation/reversal scenarios: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
