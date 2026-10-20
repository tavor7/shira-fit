#!/usr/bin/env bash
# Regression test for 20261020110000_guard_receipted_account_payments.sql (FIN-1), updated by
# 20261022100000_account_payment_history_protection.sql for the final four-state model (owner policy, 2026-10-22):
#   State A (never receipted)            -- edit/delete unrestricted (subject to existing RLS)
#   State B (active receipt)             -- cannot edit, cannot delete
#   State C (receipt cancelled, not reversed) -- MAY still be corrected, but can NEVER again be deleted (it has
#                                               receipt history, even though that receipt is now cancelled)
#   State D (reversed_at IS NOT NULL)    -- fully immutable: cannot edit, cannot delete, cannot be reversed again
#
# Real `authenticator` connections. Fixture: manager M, athlete A with an account payment PAY.
#   F  State A: no receipt yet -> manager can freely edit / delete the payment
#   L  State B: once a receipt is issued, amount/method/date/payee/payer_name/note changes are ALL refused, and
#      deletion is refused -- for the MANAGER too (deliberately stricter than the session-payment lock)
#   U  a no-op update (nothing receipt-relevant changed) still passes while a receipt is active
#   X  State C: cancelling the receipt unlocks EDITING again, but deletion remains refused forever (new this round)
#   D  State D: reversing the (cancelled) receipt's payment makes the row fully immutable -- no edit, no delete,
#      not even by a direct client attempt to set reversed_at itself
#   C  concurrency: a receipt being issued in a concurrent transaction cannot be raced past by a delete; once any
#      receipt has ever existed, a delete attempt is refused permanently, not just while the race is in flight
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/180_receipted_account_payment_lock_tests.sh   (SCRATCH/LOCAL ONLY)
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
locked()  { case "$2" in *account_payment_locked_receipt_issued*) ok "$1 (refused: receipt active)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
history_locked() { case "$2" in *account_payment_has_receipt_history*) ok "$1 (refused: has receipt history)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
reversed_locked() { case "$2" in *account_payment_reversed_immutable*) ok "$1 (refused: reversed, immutable)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
unauthorized_locked() { case "$2" in *unauthorized_payment_reversal*) ok "$1 (refused: not the authorized workflow)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
allowed() { case "$2" in *account_payment_locked_receipt_issued*|*account_payment_has_receipt_history*|*account_payment_reversed_immutable*|*unauthorized_payment_reversal*|*ERROR*) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; *) ok "$1";; esac; }
pay() { su -c "select amount_ils::text || '/' || payment_method || '/' || paid_at::text from public.athlete_account_payments where id = '$1'"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f180-$n-m@t.local', '061$n'), ('$A'::uuid, 'f180-$n-a@t.local', '062$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A');
  update public.profiles set role='manager' where user_id='$M'" >/dev/null

su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-180') where true" >/dev/null
PAY=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, note, paid_at, created_by) values ('$A', false, 100, 'cash', 'f180 note', current_date, '$M') returning id" | head -1)

echo "== F: no receipt yet -> manager edits/deletes freely"
allowed "F manager changes the amount" "$(api "$M" "update public.athlete_account_payments set amount_ils = 150 where id = '$PAY'; select 1;")"
expect "F amount saved" "150.00/cash/$(su -c "select current_date")" "$(pay $PAY)"
allowed "F manager changes the method" "$(api "$M" "update public.athlete_account_payments set payment_method = 'bit' where id = '$PAY'; select 1;")"
expect "F method saved" "150.00/bit/$(su -c "select current_date")" "$(pay $PAY)"

echo "== L: receipt issued -> locked for everyone, including the manager"
R=$(api "$M" "select public.create_document(150, 'other', 'Customer 180', null, null, 'bit', 'svc', null, '$A', null, 'account_payment', '$PAY', 'bit')::text;")
case "$R" in *'"ok" : true'*) ok "L manager issues a receipt for the account payment";; *) fail "L issue receipt: $R";; esac
DOC=$(su -c "select id from public.documents where source_id = '$PAY' and status <> 'CANCELLED' limit 1")
locked "L manager changes the amount" "$(api "$M" "update public.athlete_account_payments set amount_ils = 999 where id = '$PAY'; select 1;")"
locked "L manager changes the method" "$(api "$M" "update public.athlete_account_payments set payment_method = 'cash' where id = '$PAY'; select 1;")"
locked "L manager changes the date" "$(api "$M" "update public.athlete_account_payments set paid_at = current_date - 1 where id = '$PAY'; select 1;")"
locked "L manager changes the note" "$(api "$M" "update public.athlete_account_payments set note = 'changed' where id = '$PAY'; select 1;")"
history_locked "L manager deletes the row (delete is always refused once any receipt exists, active or not)" "$(api "$M" "delete from public.athlete_account_payments where id = '$PAY'; select 1;")"
expect "L payment unchanged after all refused attempts" "150.00/bit/$(su -c "select current_date")" "$(pay $PAY)"
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY'")
[ "$N" = "1" ] && ok "L the payment row still exists" || fail "L the payment row is gone"

echo "== U: a true no-op update still passes while receipted"
allowed "U manager re-saves identical values" "$(api "$M" "update public.athlete_account_payments set amount_ils = 150, payment_method = 'bit' where id = '$PAY'; select 1;")"

echo "== X: State C -- cancelling the receipt unlocks EDITING, but deletion remains refused forever"
R=$(api "$M" "select public.cancel_document('$DOC', 'test 180', false)::text;")
case "$R" in *'"ok" : true'*) ok "X manager cancels the receipt (payment not reversed)";; *) fail "X cancel receipt: $R";; esac
allowed "X manager can edit the payment again after cancellation (State C permits correction)" "$(api "$M" "update public.athlete_account_payments set amount_ils = 160 where id = '$PAY'; select 1;")"
history_locked "X manager can no longer delete the payment, even after cancellation (receipt history exists)" "$(api "$M" "delete from public.athlete_account_payments where id = '$PAY'; select 1;")"
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY'")
[ "$N" = "1" ] && ok "X the payment row survives forever once it has ever had a receipt" || fail "X the payment row is gone"
expect "X the edit from before the (refused) delete attempt is intact" "160.00/bit/$(su -c "select current_date")" "$(pay $PAY)"

echo "== D: State D -- reversing the payment makes it fully immutable"
PAYD=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 110, 'cash', current_date, '$M') returning id" | head -1)
R=$(api "$M" "select public.create_document(110, 'other', 'Customer 180 D', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAYD', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "D manager issues a receipt for a fresh payment";; *) fail "D issue: $R";; esac
DOCD=$(su -c "select id from public.documents where source_id = '$PAYD' and status <> 'CANCELLED' limit 1")
R=$(api "$M" "select public.cancel_document('$DOCD', 'test 180 revert', true)::text;")
case "$R" in *'"ok" : true'*'"payment_reverted" : true'*) ok "D manager cancels with revert (payment now reversed)";; *) fail "D revert: $R";; esac
reversed_locked "D manager can no longer edit the amount" "$(api "$M" "update public.athlete_account_payments set amount_ils = 999 where id = '$PAYD'; select 1;")"
reversed_locked "D manager can no longer delete the row" "$(api "$M" "delete from public.athlete_account_payments where id = '$PAYD'; select 1;")"
PAYU=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 45, 'cash', current_date, '$M') returning id" | head -1)
unauthorized_locked "D a direct client attempt to set reversed_at (bypassing cancel_document entirely) is refused" "$(api "$M" "update public.athlete_account_payments set reversed_at = now(), reversed_by = '$M' where id = '$PAYU'; select 1;")"
N=$(su -c "select (reversed_at is not null)::text from public.athlete_account_payments where id = '$PAYU'")
[ "$N" = "false" ] && ok "D the direct bypass attempt left reversed_at untouched" || fail "D reversed_at was set despite the refusal"
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAYD'")
[ "$N" = "1" ] && ok "D the reversed payment row still exists (historical auditability)" || fail "D the payment row is gone"
R2=$(api "$M" "update public.athlete_account_payments set amount_ils = amount_ils where id = '$PAYD'; select 1;")
allowed "D a true no-op save on an already-reversed row still passes" "$R2"

echo "== C: concurrent receipt issuance cannot be bypassed by a racing delete"
PAY2=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 200, 'cash', current_date, '$M') returning id" | head -1)
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.create_document(200, 'other', 'Customer 180', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY2', 'cash');
    select pg_sleep(3); commit;"; } | $PSQL_AUTH -qAt > /tmp/180_issue.log 2>&1 ) &
sleep 1
OUT=$(api "$M" "delete from public.athlete_account_payments where id = '$PAY2'; select 1;" 2>&1)
wait
history_locked "C delete issued while the receipt was being created waits (row lock), then is refused once the receipt commits" "$OUT"
N=$(su -c "select count(*) from public.athlete_account_payments where id = '$PAY2'")
[ "$N" = "1" ] && ok "C the payment survived the race" || fail "C the payment was deleted despite the race guard"
N=$(su -c "select count(*) from public.documents where source_id = '$PAY2' and status <> 'CANCELLED'")
[ "$N" = "1" ] && ok "C exactly one receipt exists for the payment" || fail "C expected 1 receipt, got $N"
# Once a receipt has ever existed, the delete stays refused permanently -- not just during the race window.
OUT2=$(api "$M" "delete from public.athlete_account_payments where id = '$PAY2'; select 1;" 2>&1)
history_locked "C a later, unhurried delete attempt is still refused (permanent, not just racy)" "$OUT2"

echo
echo "180 receipted account payment lock: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
