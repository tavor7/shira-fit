#!/usr/bin/env bash
# Regression test for 20261021110000_duplicate_active_receipt_unique_index.sql.
#
# Real `authenticator` connections. Fixture: manager M, athlete A with a session registration payment and an
# account payment.
#   S  two SEQUENTIAL attempts for the same payment: the second is refused, regardless of which RPC issues the
#      first (create_document, create_document_with_payment, create_documents_from_payments / _create_
#      document_from_payment_row) and which RPC attempts the second -- every pairing is covered
#   C  two CONCURRENT attempts for the same payment (two real, separate connections): exactly one succeeds
#   U  a direct INSERT into documents (bypassing every RPC) is refused by the unique index itself
#   R  a replacement receipt after cancellation still works (a CANCELLED document never blocks)
#   I  different payments each get their own receipt, independently
#   M  an unrelated 'manual' document (no payment source) is never affected by the invariant
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/184_duplicate_active_receipt_invariant_tests.sh (SCRATCH/LOCAL ONLY)
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
  from (values ('$M'::uuid, 'f184-$n-m@t.local', '021$n'), ('$C'::uuid, 'f184-$n-c@t.local', '022$n'), ('$A'::uuid, 'f184-$n-a@t.local', '023$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-184') where true" >/dev/null
DAY=$(su -c "select (current_date + 25)::text")

echo "== S: sequential attempts, every RPC pairing"
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '06:00', '$C', 6, true) returning id" | head -1)
REG1=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S1', '$A', 'active', true, 'cash', 80) returning id" | head -1)
R=$(api "$M" "select public.create_document(80, 'other', 'Cust S1', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "S first receipt via create_document succeeds";; *) fail "S first: $R";; esac
R=$(api "$M" "select public.create_document_with_payment('session', 80, 'other', 'cash', 'Cust S1 dup', null, null, 'svc', null, '$A', null, '$S1', null, false)::text;")
case "$R" in *document_already_exists*) ok "S second attempt via create_document_with_payment refused";; *) fail "S second (via with_payment): $R";; esac
R=$(api "$M" "select public.create_documents_from_payments('[\"session_reg:$REG1\"]'::jsonb)::text;")
case "$R" in *document_already_exists*) ok "S third attempt via create_documents_from_payments also refused";; *) fail "S third (via deferred): $R";; esac

S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '07:00', '$C', 6, true) returning id" | head -1)
REG2=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S2', '$A', 'active', true, 'cash', 90) returning id" | head -1)
R=$(api "$M" "select public.create_documents_from_payments('[\"session_reg:$REG2\"]'::jsonb)::text;")
case "$R" in *'"created_count" : 1'*) ok "S first receipt via the deferred path succeeds";; *) fail "S first (deferred): $R";; esac
R=$(api "$M" "select public.create_document(90, 'other', 'Cust S2 dup', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG2', 'cash')::text;")
case "$R" in *document_already_exists*) ok "S second attempt (plain create_document) refused";; *) fail "S second (plain): $R";; esac
N=$(su -c "select count(*) from public.documents where source_id in ('$REG1','$REG2') and status <> 'CANCELLED'")
expect "S exactly one active receipt per payment after all sequential attempts" "2" "$N"

echo "== C: concurrent attempts for the same payment"
S3=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '08:00', '$C', 6, true) returning id" | head -1)
REG3=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S3', '$A', 'active', true, 'cash', 70) returning id" | head -1)
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.create_document(70, 'other', 'Cust C race A', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG3', 'cash');
    commit;"; } | $PSQL_AUTH -qAt > /tmp/184_race_a.log 2>&1 ) &
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.create_document_with_payment('session', 70, 'other', 'cash', 'Cust C race B', null, null, 'svc', null, '$A', null, '$S3', null, false);
    commit;"; } | $PSQL_AUTH -qAt > /tmp/184_race_b.log 2>&1 ) &
wait
OUT_A=$(cat /tmp/184_race_a.log); OUT_B=$(cat /tmp/184_race_b.log)
SUCCESSES=0
case "$OUT_A" in *'"ok" : true'*) SUCCESSES=$((SUCCESSES+1));; esac
case "$OUT_B" in *'"ok" : true'*) SUCCESSES=$((SUCCESSES+1));; esac
[ "$SUCCESSES" = "1" ] && ok "C exactly one of the two concurrent attempts succeeded" || fail "C expected exactly 1 success, got $SUCCESSES (A=$OUT_A B=$OUT_B)"
N=$(su -c "select count(*) from public.documents where source_id = '$REG3' and status <> 'CANCELLED'")
expect "C exactly one active receipt exists after the race, regardless of which RPC won" "1" "$N"
BOTH_CLEAN=true
case "$OUT_A$OUT_B" in *permission*|*"ERROR:"*) BOTH_CLEAN=false;; esac
$BOTH_CLEAN && ok "C the losing call got a clean JSON refusal, not a raw database exception" || fail "C a raw exception leaked: A=$OUT_A B=$OUT_B"

echo "== U: a direct INSERT bypassing every RPC is refused by the index itself"
PAY1=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 50, 'cash', current_date, '$M') returning id" | head -1)
R1=$(api "$M" "select public.create_document(50, 'other', 'Cust U', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY1', 'cash')::text;")
case "$R1" in *'"ok" : true'*) ok "U first receipt issued normally";; *) fail "U first: $R1";; esac
OUT=$(api "$M" "insert into public.documents (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, payment_method, service_type, status, customer_name, business_name, business_id, business_address, business_phone, business_email, source_type, source_id, created_by)
  select 'SF-DIRECT-$n', customer_id, 50, 45.45, 4.55, 0.1, 'cash', 'other', 'ACTIVE', 'Direct', business_name, business_id, business_address, business_phone, business_email, 'account_payment', '$PAY1', '$M'
  from public.documents where source_id = '$PAY1' limit 1;" 2>&1)
case "$OUT" in
  *duplicate*|*unique*|*"document_already_exists"*) ok "U direct bypass insert refused by the unique index";;
  *"row-level security"*) ok "U direct bypass insert refused by RLS before even reaching the index (documents has no authenticated-role INSERT policy -- an even stronger guarantee than the index alone)";;
  *) fail "U direct insert NOT refused: $OUT";;
esac
N=$(su -c "select count(*) from public.documents where source_id = '$PAY1' and status <> 'CANCELLED'")
expect "U still exactly one active receipt after the bypass attempt" "1" "$N"
# Prove the INDEX itself (not RLS) is the real guarantee: insert as superuser, which bypasses RLS entirely.
OUT_SU=$($PSQL -qAt -c "insert into public.documents (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, payment_method, service_type, service_description, status, customer_name, business_name, business_id, business_address, business_phone, business_email, source_type, source_id, created_by)
  select 'SF-SUPERUSER-$n', customer_id, 50, 45.45, 4.55, 0.1, 'cash', 'other', 'direct su test', 'ACTIVE', 'Direct SU', business_name, business_id, business_address, business_phone, business_email, 'account_payment', '$PAY1', '$M'
  from public.documents where source_id = '$PAY1' limit 1;" 2>&1)
case "$OUT_SU" in *duplicate*|*unique*) ok "U the unique index itself refuses a superuser insert that bypasses RLS entirely";; *) fail "U superuser insert NOT refused by the index: $OUT_SU";; esac

echo "== R: replacement receipt after cancellation still works"
DOCU=$(su -c "select id from public.documents where source_id = '$PAY1' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOCU', 'test 184 R', false)::text;")
case "$R" in *'"ok" : true'*) ok "R manager cancels the first receipt";; *) fail "R cancel: $R";; esac
R=$(api "$M" "select public.create_document(50, 'other', 'Cust R replacement', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "R replacement receipt succeeds (cancelled doc never blocks)";; *) fail "R replacement: $R";; esac
N=$(su -c "select count(*) from public.documents where source_id = '$PAY1' and status <> 'CANCELLED'")
expect "R exactly one active receipt after cancel+replace" "1" "$N"

echo "== I: different payments each get their own receipt independently"
PAY2=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 65, 'bit', current_date, '$M') returning id" | head -1)
R=$(api "$M" "select public.create_document(65, 'other', 'Cust I', null, null, 'bit', 'svc', null, '$A', null, 'account_payment', '$PAY2', 'bit')::text;")
case "$R" in *'"ok" : true'*) ok "I an unrelated payment gets its own receipt without interference";; *) fail "I: $R";; esac

echo "== M: unrelated 'manual' documents (no payment source) are never affected"
R1=$(api "$M" "select public.create_document(30, 'other', 'Manual doc 1', null, null, 'cash', 'misc', null, null, null, 'manual', null, null)::text;")
R2=$(api "$M" "select public.create_document(30, 'other', 'Manual doc 2', null, null, 'cash', 'misc', null, null, null, 'manual', null, null)::text;")
case "$R1$R2" in *'"ok" : true'*'"ok" : true'*) ok "M two unrelated manual documents both succeed (no payment source, invariant does not apply)";; *) fail "M: R1=$R1 R2=$R2";; esac

echo
echo "184 duplicate active receipt invariant: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
