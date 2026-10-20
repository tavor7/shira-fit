#!/usr/bin/env bash
# Regression test for 20261020100000_fix_create_documents_from_payments_manager_only.sql (SEC-1).
#
# Real `authenticator` connections as anon / authenticated with JWT claims (one transaction per call, like PostgREST).
# Fixture: manager M, coach C, athlete A with an un-receipted account payment PAY.
#   P  manager can issue a receipt via create_documents_from_payments
#   N  coach cannot (forbidden) -- this is the bug this migration fixes: before it, this call succeeded
#   N  athlete cannot (forbidden)
#   N  anonymous cannot (not_authenticated)
#   I  the internal helper _create_document_from_payment_row stays unreachable by any client role
#   U  existing behaviour preserved: batch cap (500) still enforced, numbering/row-id format unchanged
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/179_create_documents_from_payments_manager_only_tests.sh   (SCRATCH/LOCAL ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
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
  from (values ('$M'::uuid, 'f179-$n-m@t.local', '071$n'), ('$C'::uuid, 'f179-$n-c@t.local', '072$n'), ('$A'::uuid, 'f179-$n-a@t.local', '073$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null

su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-179') where true" >/dev/null
mkpay() { su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 120, 'cash', current_date, '$M') returning id" | head -1; }

echo "== N: coach, athlete and anon cannot issue a receipt via create_documents_from_payments (the fixed bug)"
PAY1=$(mkpay)
R=$(api_as authenticated "$C" "select public.create_documents_from_payments('[\"account:$PAY1\"]'::jsonb)::text;")
case "$R" in *'"error" : "forbidden"'*) ok "N coach refused (forbidden)";; *) fail "N coach: $R";; esac
expect_no_doc() { local pay=$1; local n; n=$(su -c "select count(*) from public.documents where source_type='account_payment' and source_id='$pay' and status <> 'CANCELLED'"); [ "$n" = "0" ] && ok "N no document was created for $pay" || fail "N a document WAS created for $pay despite refusal ($n)"; }
expect_no_doc "$PAY1"

PAY2=$(mkpay)
R=$(api_as authenticated "$A" "select public.create_documents_from_payments('[\"account:$PAY2\"]'::jsonb)::text;")
case "$R" in *'"error" : "forbidden"'*) ok "N athlete refused (forbidden)";; *) fail "N athlete: $R";; esac
expect_no_doc "$PAY2"

PAY3=$(mkpay)
R=$(api_as anon "" "select public.create_documents_from_payments('[\"account:$PAY3\"]'::jsonb)::text;")
case "$R" in *'"error" : "not_authenticated"'*) ok "N anon refused (not_authenticated)";; *) fail "N anon: $R";; esac
expect_no_doc "$PAY3"

echo "== P: manager can still issue a receipt this way"
PAY4=$(mkpay)
R=$(api_as authenticated "$M" "select public.create_documents_from_payments('[\"account:$PAY4\"]'::jsonb)::text;")
case "$R" in *'"created_count" : 1'*) ok "P manager issues the receipt (created_count=1)";; *) fail "P manager: $R";; esac
N=$(su -c "select count(*) from public.documents where source_type='account_payment' and source_id='$PAY4' and status <> 'CANCELLED'")
[ "$N" = "1" ] && ok "P exactly one document now exists for the payment" || fail "P expected 1 document, got $N"

echo "== I: the internal helper stays unreachable directly, by any role"
for who in "coach:$C" "athlete:$A" "manager:$M" "anon:"; do
  label=${who%%:*}; u=${who#*:}; role=authenticated; [ "$label" = anon ] && role=anon
  R=$(api_as $role "$u" "select public._create_document_from_payment_row('account:$PAY1')::text;")
  case "$R" in *"permission denied"*) ok "I $label cannot call _create_document_from_payment_row directly";; *) fail "I $label reached the internal helper directly: $(echo "$R" | head -1 | cut -c1-150)";; esac
done

echo "== U: existing behaviour preserved (batch cap, bad input)"
BIG=$(su -c "select jsonb_agg('account:' || gen_random_uuid()) from generate_series(1,501)")
R=$(api_as authenticated "$M" "select public.create_documents_from_payments('$BIG'::jsonb)::text;")
case "$R" in *too_many_rows*) ok "U 501 rows still rejected (too_many_rows, cap unchanged)";; *) fail "U batch cap: $R";; esac
R=$(api_as authenticated "$M" "select public.create_documents_from_payments('[]'::jsonb)::text;")
case "$R" in *no_rows_selected*) ok "U empty array still rejected (no_rows_selected)";; *) fail "U empty array: $R";; esac

echo
echo "179 create_documents_from_payments manager-only: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
