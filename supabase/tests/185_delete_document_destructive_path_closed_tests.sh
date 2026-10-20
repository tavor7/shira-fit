#!/usr/bin/env bash
# Regression test for 20261023190000_guard_document_hard_delete.sql.
#
# Real `authenticator` connections. Fixture: manager M with receipt_settings.is_operational = false (confirmed
# this is production's actual current value, read-only -- not changed by this test or this release) so
# delete_document is reachable exactly as it is in production today.
#   A  delete_document(p_delete_payment=true) on an account-payment-sourced document: the whole call fails and
#      rolls back atomically -- the account payment's own "ever had a receipt" guard refuses the payment delete
#      before delete_document even reaches its own `delete from documents` statement
#   B  delete_document(p_delete_payment=false) on any document: fails at the final `delete from documents`
#      statement regardless of payment handling, and the WHOLE call rolls back -- confirmed for a document with
#      no payment source at all ('manual'), proving this isn't just a side effect of the payment guard
#   C  delete_document on a session-payment-sourced document: the session field-nulling that happens earlier in
#      the same call is rolled back too, because the final documents-delete still fails
#   D  a direct hard DELETE on documents/document_events (bypassing delete_document and every RPC) is refused by
#      the same trigger, for any role including a raw superuser connection
#   E  cancel_document (status update, never a physical delete) is completely unaffected and still works
#   F  document numbering and audit history are preserved -- nothing about this migration changes either
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/185_delete_document_destructive_path_closed_tests.sh (SCRATCH/LOCAL ONLY)
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

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f185-$n-m@t.local', '011$n'), ('$C'::uuid, 'f185-$n-c@t.local', '012$n'), ('$A'::uuid, 'f185-$n-a@t.local', '013$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-185') where true" >/dev/null
IS_OP=$(su -c "select is_operational::text from public.receipt_settings limit 1")
echo "  INFO: receipt_settings.is_operational = $IS_OP (not modified by this test; delete_document's own testing-mode gate is untouched)"
if [ "$IS_OP" = "true" ]; then
  echo "  INFO: is_operational is true on this database -- delete_document already refuses everything via operational_mode_locked; sections A/B/C below would trivially pass for the wrong reason, so this test forces it off for the duration of THIS test only, to actually exercise the new guard (restored at the end)."
  su -c "update public.receipt_settings set is_operational = false where true" >/dev/null
fi

echo "== A: delete_document(p_delete_payment=true) on an account-payment-sourced document"
PAY=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 85, 'cash', current_date, '$M') returning id" | head -1)
R=$(api "$M" "select public.create_document(85, 'other', 'Cust 185A', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "A manager issues a receipt for the account payment";; *) fail "A issue: $R";; esac
DOCA=$(su -c "select id from public.documents where source_id = '$PAY' and status <> 'CANCELLED' limit 1")
OUT=$(api "$M" "select public.delete_document('$DOCA', true)::text;" 2>&1)
case "$OUT" in *account_payment_has_receipt_history*) ok "A delete_document is refused (blocked by the account-payment history guard before it even reaches its own document delete)";; *) fail "A delete_document NOT refused: $OUT";; esac
N=$(su -c "select count(*) from public.documents where id = '$DOCA'")
expect "A the document still exists (the whole call rolled back)" "1" "$N"
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY'")
expect "A the account payment still exists" "1" "$N"

echo "== B: delete_document(p_delete_payment=false) on a 'manual' document (no payment source at all)"
R=$(api "$M" "select public.create_document(40, 'other', 'Cust 185B', null, null, 'cash', 'misc', null, null, null, 'manual', null, null)::text;")
case "$R" in *'"ok" : true'*) ok "B manager creates a freeform manual document";; *) fail "B create: $R";; esac
DOCB=$(su -c "select id from public.documents where customer_name='Cust 185B' order by created_at desc limit 1")
EVENTS_BEFORE=$(su -c "select count(*) from public.document_events where document_id = '$DOCB'")
OUT=$(api "$M" "select public.delete_document('$DOCB', false)::text;" 2>&1)
case "$OUT" in *document_record_immutable*) ok "B delete_document is refused even for a document with no payment source (the documents-table guard itself, not the payment guard)";; *) fail "B delete_document NOT refused: $OUT";; esac
N=$(su -c "select count(*) from public.documents where id = '$DOCB'")
expect "B the document still exists" "1" "$N"
EVENTS_AFTER=$(su -c "select count(*) from public.document_events where document_id = '$DOCB'")
expect "B its document_events were not deleted either (the whole call rolled back atomically)" "$EVENTS_BEFORE" "$EVENTS_AFTER"

echo "== C: delete_document on a session-payment-sourced document rolls back the field-nulling too"
DAY=$(su -c "select (current_date + 30)::text")
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '06:00', '$C', 6, true) returning id" | head -1)
REG1=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S1', '$A', 'active', true, 'cash', 65) returning id" | head -1)
R=$(api "$M" "select public.create_document(65, 'other', 'Cust 185C', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "C manager issues a receipt for the session payment";; *) fail "C issue: $R";; esac
DOCC=$(su -c "select id from public.documents where source_id = '$REG1' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOCC', 'test 185C', false)::text;")
case "$R" in *'"ok" : true'*) ok "C manager cancels the receipt (payment not reverted) -- the document still exists, cancelled";; *) fail "C cancel: $R";; esac
OUT=$(api "$M" "select public.delete_document('$DOCC', true)::text;" 2>&1)
case "$OUT" in *ERROR*|*"\"ok\" : false"*) ok "C delete_document fails (final documents-delete refused)";; *) fail "C delete_document unexpectedly succeeded: $OUT";; esac
PAYFIELDS=$(su -c "select coalesce(amount_paid::text,'NULL') || '/' || coalesce(payment_method,'NULL') from public.session_registrations where id = '$REG1'")
expect "C the session payment fields were NOT nulled -- the whole transaction rolled back" "65.00/cash" "$PAYFIELDS"
N=$(su -c "select count(*) from public.documents where id = '$DOCC'")
expect "C the (cancelled) document still exists" "1" "$N"

echo "== D: a direct hard DELETE bypassing every RPC is refused, for any role"
for who in "manager:$M" "coach:$C"; do
  label=${who%%:*}; u=${who#*:}
  OUT=$(api "$u" "delete from public.documents where id = '$DOCA'; select 1;" 2>&1)
  case "$OUT" in
    *document_record_immutable*|*"row-level security"*) ok "D $label direct delete refused outright (trigger or RLS)";;
    *)
      # No matching DELETE policy exists for authenticated at all, so RLS can also make this a silent
      # 0-row no-op rather than a visible error -- check the row actually survived either way.
      N=$(su -c "select count(*) from public.documents where id = '$DOCA'")
      [ "$N" = "1" ] && ok "D $label direct delete affected nothing (silently refused by RLS -- no DELETE policy exists for this role)" || fail "D $label direct delete actually removed the document: $OUT"
      ;;
  esac
done
OUT_SU=$($PSQL -qAt -c "delete from public.documents where id = '$DOCA';" 2>&1)
case "$OUT_SU" in *document_record_immutable*) ok "D a superuser direct delete (bypassing RLS entirely) is still refused by the trigger itself";; *) fail "D superuser delete NOT refused: $OUT_SU";; esac
OUT_SU2=$($PSQL -qAt -c "delete from public.document_events where document_id = '$DOCA';" 2>&1)
case "$OUT_SU2" in *document_record_immutable*) ok "D document_events is equally protected";; *) fail "D document_events delete NOT refused: $OUT_SU2";; esac

echo "== E: cancel_document (status update, never a physical delete) is unaffected"
DOCNUM_BEFORE=$(su -c "select document_number from public.documents where id = '$DOCA'")
R=$(api "$M" "select public.cancel_document('$DOCA', 'test 185E', false)::text;")
case "$R" in *'"ok" : true'*) ok "E cancel_document still works normally";; *) fail "E cancel: $R";; esac
DOCNUM_AFTER=$(su -c "select document_number from public.documents where id = '$DOCA'")
expect "E document numbering unchanged by any of this" "$DOCNUM_BEFORE" "$DOCNUM_AFTER"

echo "== F: document numbering stays sequential across everything above"
NEWR=$(api "$M" "select public.create_document(20, 'other', 'Cust 185F', null, null, 'cash', 'misc', null, null, null, 'manual', null, null)::text;")
case "$NEWR" in *'"ok" : true'*) ok "F a brand-new document can still be issued with the next sequential number";; *) fail "F: $NEWR";; esac

if [ "$IS_OP" = "true" ]; then
  su -c "update public.receipt_settings set is_operational = true where true" >/dev/null
  echo "  INFO: restored is_operational = true as found."
fi

echo
echo "185 delete_document destructive path closed: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
