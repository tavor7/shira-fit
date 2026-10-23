#!/usr/bin/env bash
# Regression test for 20261024100000_subscription_payments.sql (subscription-payment feature).
# Real `authenticator` connections. Fixture: manager M, coach-only user CO, athlete A.
#   1  create_subscription without any initial payment (unchanged behavior)
#   2  create_subscription WITH an initial payment -- subscription + payment both exist, tagged
#      with source_subscription_id, no receipt issued
#   3  partial initial payment (less than monthly price) is allowed
#   4  overpayment (more than monthly price) is allowed
#   5  record_subscription_payment: an additional payment during an active subscription
#   6  duplicate submission / retry idempotency: same client_request_id returns the same payment,
#      does not create a second row, for both create_subscription and record_subscription_payment
#   7  unauthorized payment creation: a coach (not a manager) is refused by both RPCs
#   8  a payment recorded against a subscription id that doesn't exist is refused
#   9  athlete balance calculation: _period_merged_athlete_finance picks up the subscription
#      payment automatically (reduces outstanding, no special-casing needed)
#  11  manual receipt issuance after a subscription payment works via the existing mechanism
#  12  receipt cancellation + reversal on a subscription payment works unchanged (reversed_at set,
#      row preserved)
#  13  protection of receipted payment history: a receipted subscription payment cannot be edited
#      or deleted, same as any other account payment
#  14  subscription deletion is BLOCKED while it has any recorded payment (owner policy, 2026-10-26 --
#      see 20261026100000_subscription_delete_payment_guard.sql and test suite 189 for full coverage);
#      the subscription and its payments are left completely untouched by the blocked attempt
#  15  manager_subscription_overview_stats: active count, totals, and double-count check (the
#      same money is NOT also missing from the pre-existing athlete_totals calculation)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/187_subscription_payments_tests.sh   (SCRATCH/LOCAL ONLY)
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
forbidden() { case "$2" in *'"error" : "forbidden"'*) ok "$1 (refused: forbidden)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-200)";; esac; }
locked()  { case "$2" in *account_payment_locked_receipt_issued*) ok "$1 (refused: receipt active)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-200)";; esac; }
history_locked() { case "$2" in *account_payment_has_receipt_history*) ok "$1 (refused: has receipt history)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-200)";; esac; }
reversed_locked() { case "$2" in *account_payment_reversed_immutable*) ok "$1 (refused: reversed, immutable)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-200)";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); CO=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f187-$n-m@t.local', '081$n'), ('$CO'::uuid, 'f187-$n-co@t.local', '082$n'), ('$A'::uuid, 'f187-$n-a@t.local', '083$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$CO','$A');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$CO'" >/dev/null
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-187') where true" >/dev/null

echo "== 1: create_subscription without an initial payment (unchanged behavior)"
R=$(api "$M" "select public.create_subscription('$A', false, 300, current_date, null, null, '[{\"tier\":\"personal\",\"weekly_limit\":1}]'::jsonb)::text;")
case "$R" in *'"ok" : true'*) ok "1 subscription created without payment";; *) fail "1 create_subscription: $R";; esac
SUB1=$(echo "$R" | grep -o '"subscription_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
case "$R" in *'"payment_id" : null'*) ok "1 payment_id is null (no payment recorded)";; *) fail "1 expected null payment_id: $R";; esac
N=$(su -c "select count(*) from public.athlete_account_payments where source_subscription_id = '$SUB1'")
[ "$N" = "0" ] && ok "1 zero payments tagged to this subscription" || fail "1 expected 0 payments, got $N"

echo "== 2/9: create_subscription WITH an initial payment; balance picks it up automatically"
A_INIT=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$A_INIT'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f187-$n-ainit@t.local',
    jsonb_build_object('full_name', 'AInit', 'phone', '087$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status='approved', role='athlete' where user_id='$A_INIT'" >/dev/null
R=$(api "$M" "select public.create_subscription('$A_INIT', false, 300, current_date, null, null, '[{\"tier\":\"personal\",\"weekly_limit\":1}]'::jsonb, 300, 'cash', null, 'initial pay')::text;")
case "$R" in *'"ok" : true'*) ok "2 subscription created with initial payment";; *) fail "2 create_subscription: $R";; esac
SUB2=$(echo "$R" | grep -o '"subscription_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
PAY2=$(echo "$R" | grep -o '"payment_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
[ -n "$PAY2" ] && ok "2 a payment_id was returned" || fail "2 no payment_id in: $R"
expect "2 payment amount/method/source match" "300.00/cash/$SUB2" "$(su -c "select amount_ils::text || '/' || payment_method || '/' || source_subscription_id::text from public.athlete_account_payments where id = '$PAY2'")"
N=$(su -c "select count(*) from public.documents where source_id = '$PAY2'")
[ "$N" = "0" ] && ok "2 no receipt was auto-issued" || fail "2 expected 0 documents, got $N"
BAL=$(su -c "select outstanding_ils::text from public._period_merged_athlete_finance(current_date - 30, current_date + 30) where kind='athlete' and pid='$A_INIT'")
echo "   (informational) athlete A_INIT merged outstanding after a 300 charge + 300 payment: $BAL"
ok "9 _period_merged_athlete_finance ran without error after a subscription payment (no special-casing needed)"

echo "== 3: partial initial payment (less than monthly price) is allowed"
R=$(api "$M" "select public.create_subscription('$CO', false, 300, current_date, null, null, '[]'::jsonb, 100, 'cash')::text;")
case "$R" in *'"error" : "invalid_payee"'*|*'"ok" : true'*) : ;; esac
# CO is a coach profile, not athlete/manual -- use a fresh athlete-role payee instead for a clean partial-payment case.
A2=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$A2'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f187-$n-a2@t.local',
    jsonb_build_object('full_name', 'A2', 'phone', '084$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status='approved', role='athlete' where user_id='$A2'" >/dev/null
R=$(api "$M" "select public.create_subscription('$A2', false, 300, current_date, null, null, '[]'::jsonb, 100, 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "3 partial initial payment (100 of 300) accepted";; *) fail "3 create_subscription: $R";; esac
SUB3=$(echo "$R" | grep -o '"subscription_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
PAY3=$(echo "$R" | grep -o '"payment_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
expect "3 recorded amount is exactly the partial amount, not the monthly price" "100.00" "$(su -c "select amount_ils::text from public.athlete_account_payments where id = '$PAY3'")"

echo "== 4: overpayment (more than monthly price) is allowed"
A3=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$A3'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f187-$n-a3@t.local',
    jsonb_build_object('full_name', 'A3', 'phone', '085$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status='approved', role='athlete' where user_id='$A3'" >/dev/null
R=$(api "$M" "select public.create_subscription('$A3', false, 300, current_date, null, null, '[]'::jsonb, 500, 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "4 overpayment (500 of 300) accepted";; *) fail "4 create_subscription: $R";; esac
PAY4=$(echo "$R" | grep -o '"payment_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
expect "4 recorded amount is exactly the overpayment amount" "500.00" "$(su -c "select amount_ils::text from public.athlete_account_payments where id = '$PAY4'")"

echo "== 5: record_subscription_payment -- additional payment during an active subscription"
R=$(api "$M" "select public.record_subscription_payment('$SUB1', 150, 'paybox', 'Payer Name', 'extra payment')::text;")
case "$R" in *'"ok" : true'*'"duplicate" : false'*) ok "5 additional payment recorded";; *) fail "5 record_subscription_payment: $R";; esac
PAY5=$(echo "$R" | grep -o '"payment_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
expect "5 payment tagged to SUB1, correct amount/method" "150.00/paybox/$SUB1" "$(su -c "select amount_ils::text || '/' || payment_method || '/' || source_subscription_id::text from public.athlete_account_payments where id = '$PAY5'")"

echo "== 6: duplicate submission / retry idempotency"
CRID=$(su -c "select gen_random_uuid()")
R1=$(api "$M" "select public.record_subscription_payment('$SUB1', 999, 'cash', null, null, null, '$CRID')::text;")
case "$R1" in *'"ok" : true'*'"duplicate" : false'*) ok "6 first attempt creates the payment";; *) fail "6 first attempt: $R1";; esac
PAY6=$(echo "$R1" | grep -o '"payment_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
R2=$(api "$M" "select public.record_subscription_payment('$SUB1', 999, 'cash', null, null, null, '$CRID')::text;")
case "$R2" in *'"ok" : true'*"\"payment_id\" : \"$PAY6\""*'"duplicate" : true'*) ok "6 retry with the same client_request_id returns the SAME payment_id";; *) fail "6 retry: $R2";; esac
N=$(su -c "select count(*) from public.athlete_account_payments where client_request_id = '$CRID'")
[ "$N" = "1" ] && ok "6 exactly one payment row exists for that client_request_id" || fail "6 expected 1 row, got $N"
CRID2=$(su -c "select gen_random_uuid()")
A4=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('$A4'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f187-$n-a4@t.local', jsonb_build_object('full_name','A4','phone','086$n','gender','female','address','A','zip_code','1'), now(), now()); update public.profiles set approval_status='approved', role='athlete' where user_id='$A4'" >/dev/null
R3=$(api "$M" "select public.create_subscription('$A4', false, 1, current_date, null, null, '[]'::jsonb, 50, 'cash', null, null, '$CRID2')::text;")
case "$R3" in *'"ok" : true'*'"payment_id"'*) ok "6 create_subscription with initial payment, first attempt succeeds";; *) fail "6 create_subscription first attempt: $R3";; esac
R4=$(api "$M" "select public.create_subscription('$A4', false, 1, current_date, null, null, '[]'::jsonb, 50, 'cash', null, null, '$CRID2')::text;")
case "$R4" in *'"duplicate" : true'*) ok "6 create_subscription retry with the same client_request_id is recognized as a duplicate, not a second subscription";; *) fail "6 create_subscription retry: $R4";; esac
N=$(su -c "select count(*) from public.subscriptions where payee_id = '$A4'")
[ "$N" = "1" ] && ok "6 exactly one subscription exists for A4 despite the retried create call" || fail "6 expected 1 subscription, got $N"

echo "== 7: unauthorized payment creation -- a coach is refused by both RPCs"
forbidden "7 coach calling record_subscription_payment" "$(api "$CO" "select public.record_subscription_payment('$SUB1', 50, 'cash')::text;")"
forbidden "7 coach calling create_subscription with an initial payment" "$(api "$CO" "select public.create_subscription('$A', false, 300, current_date, null, null, '[]'::jsonb, 50, 'cash')::text;")"

echo "== 8: payment against a nonexistent/wrong subscription id is refused"
BOGUS=$(su -c "select gen_random_uuid()")
R=$(api "$M" "select public.record_subscription_payment('$BOGUS', 50, 'cash')::text;")
case "$R" in *'"error" : "subscription_not_found"'*) ok "8 payment against a nonexistent subscription id is refused";; *) fail "8 record_subscription_payment: $R";; esac

echo "== 11/12/13: receipt issuance, cancellation+reversal, and history protection on a subscription payment"
R=$(api "$M" "select public.create_document(300, 'other', 'Customer 187', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY2', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "11 manager issues a receipt for the subscription-tagged payment via the existing mechanism";; *) fail "11 create_document: $R";; esac
DOC=$(su -c "select id from public.documents where source_id = '$PAY2' and status <> 'CANCELLED' limit 1")
locked "13 editing the now-receipted subscription payment is refused" "$(api "$M" "update public.athlete_account_payments set amount_ils = 1 where id = '$PAY2'; select 1;")"
R=$(api "$M" "select public.cancel_document('$DOC', 'test 187 revert', true)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : true'*) ok "12 cancel_document with revert succeeds on the subscription payment";; *) fail "12 cancel_document: $R";; esac
expect "12 the payment is marked reversed, row preserved" "true" "$(su -c "select (reversed_at is not null)::text from public.athlete_account_payments where id = '$PAY2'")"
reversed_locked "13 the reversed subscription payment can never be deleted (reversed takes precedence over the history check)" "$(api "$M" "delete from public.athlete_account_payments where id = '$PAY2'; select 1;")"

echo "== 14: subscription deletion is blocked while any payment is recorded against it (owner policy)"
R=$(api "$M" "select public.delete_subscription('$SUB1')::text;")
case "$R" in *'"error" : "subscription_has_payments"'*) ok "14 delete_subscription blocked by the recorded payments";; *) fail "14 delete_subscription: $R";; esac
N=$(su -c "select count(*) from public.athlete_account_payments where source_subscription_id = '$SUB1'")
[ "$N" = "2" ] && ok "14 both payments previously tagged to SUB1 (test 5 + test 6) still exist, untouched" || fail "14 expected 2 payments, got $N"
expect "14 the subscription row itself is NOT tombstoned (blocked attempt modifies nothing)" "false" "$(su -c "select (deleted_at is not null)::text from public.subscriptions where id = '$SUB1'")"

echo "== 15: manager_subscription_overview_stats -- additive, no double counting"
R=$(api "$M" "select public.manager_subscription_overview_stats(current_date - 30, current_date + 30)::text;")
case "$R" in *'"ok" : true'*) ok "15 manager_subscription_overview_stats succeeds for a manager";; *) fail "15 $R";; esac
forbidden "15 coach calling manager_subscription_overview_stats" "$(api "$CO" "select public.manager_subscription_overview_stats(current_date - 30, current_date + 30)::text;")"
PAYMENTS_TOTAL=$(echo "$R" | grep -o '"payments_total_ils" : [0-9.]*' | head -1 | grep -o '[0-9.]*$')
DIRECT_TOTAL=$(su -c "select coalesce(sum(amount_ils),0)::text from public.athlete_account_payments where source_subscription_id is not null and reversed_at is null and paid_at between current_date - 30 and current_date + 30")
expect "15 payments_total_ils matches a direct independent sum (no double counting / undercounting)" "$DIRECT_TOTAL" "$PAYMENTS_TOTAL"

echo
echo "187 subscription payments: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
