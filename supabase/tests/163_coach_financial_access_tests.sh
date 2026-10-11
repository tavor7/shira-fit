#!/usr/bin/env bash
# Regression test for 20261013130000_restrict_coach_financial_access.sql (coach authorization).
#
# Every call goes over a real `authenticator` connection as anon / authenticated with JWT claims (one transaction per call,
# like PostgREST). Fixture: manager M, coach C (owns session S1), coach C2 (owns session S2), athlete A registered to S1.
#   N  coach (and athlete, anon) are refused: account payments read/insert/update/delete, documents, document events,
#      customers, external receipts, receipt settings, receipt PDFs (storage, when present), the 12 finance RPCs, studio and
#      per-athlete price writes, roster rate writes on another coach's session
#   P  legitimate paths still work: manager full access (payments CRUD, documents, finance RPCs, price writes); coach reads
#      prices, records attendance + payment at check-in on own session, sets a roster rate on own session, reads own session
#      roster; the coach's attendance on another coach's session stays refused (pre-existing scope)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/163_coach_financial_access_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
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
# refused = permission denied, forbidden JSON, or an RLS-filtered empty result / zero-row write
refused() { case "$2" in *"permission denied"*|*forbidden*|*"row-level security"*|"0"|""|"[]") ok "N $1 refused";; *) fail "N $1 NOT refused: $(echo "$2" | head -1 | cut -c1-140)";; esac; }
works() { case "$2" in *"permission denied"*|*forbidden*|*"row-level security"*|*ERROR*) fail "P $1: $(echo "$2" | grep -m1 -E 'ERROR|denied|forbidden' | cut -c1-160)";; *) ok "P $1";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); C2=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f163-$n-m@t.local', '081$n'), ('$C'::uuid, 'f163-$n-c@t.local', '082$n'),
               ('$C2'::uuid, 'f163-$n-c2@t.local', '083$n'), ('$A'::uuid, 'f163-$n-a@t.local', '084$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$C2','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id in ('$C','$C2')" >/dev/null
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 2, '09:15', '$C', 4, true) returning id" | head -1)
S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 2, '09:30', '$C2', 4, true) returning id" | head -1)
su -c "insert into public.session_registrations (session_id, user_id, status) values ('$S1', '$A', 'active'), ('$S2', '$A', 'active')" >/dev/null
PAY=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 100, 'cash', current_date, '$M') returning id" | head -1)
DOCP=$(api "$M" "select (public.create_document(100, 'other', 'Customer 163', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY', 'cash')->>'document_id');" | grep -E '^[0-9a-f-]{36}$')
DOC=$(api "$M" "select (public.create_document(55, 'other', 'Customer 163', null, null, 'cash', 'svc', null, '$A', null, 'manual', null, null)->>'document_id');" | grep -E '^[0-9a-f-]{36}$')

echo "== N: coach / athlete / anon cannot reach studio-wide financial and customer data"
for who in "coach:$C" "athlete:$A" "anon:"; do label=${who%%:*}; u=${who#*:}; role=authenticated; [ "$label" = anon ] && role=anon
  refused "$label reads account payments" "$(api_as $role "$u" "select count(*) from public.athlete_account_payments;")"
  refused "$label inserts an account payment" "$(api_as $role "$u" "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at) values ('$A', false, 1, 'cash', current_date); select 1;")"
  refused "$label updates an account payment" "$(api_as $role "$u" "with u as (update public.athlete_account_payments set amount_ils = 1 where id = '$PAY' returning 1) select count(*) from u;")"
  refused "$label deletes an account payment" "$(api_as $role "$u" "with d as (delete from public.athlete_account_payments where id = '$PAY' returning 1) select count(*) from d;")"
  for t in documents document_events customers external_manual_receipts receipt_settings; do
    refused "$label reads $t" "$(api_as $role "$u" "select count(*) from public.$t;")"
  done
  refused "$label writes studio prices" "$(api_as $role "$u" "with u as (update public.session_capacity_pricing set price_ils = price_ils where true returning 1) select count(*) from u;")"
  refused "$label writes per-athlete prices" "$(api_as $role "$u" "insert into public.athlete_session_capacity_pricing select * from public.athlete_session_capacity_pricing limit 0; with u as (update public.athlete_session_capacity_pricing set price_ils = price_ils where true returning 1) select count(*) from u;")"
  for call in "public.create_document(10, 'other', 'X', null, null, 'cash', 'x', null, '$A', null, 'manual', null, null)" \
              "public.cancel_document('$DOC', 'x', false)" "public.list_documents(null, null, null, null, 10, 0)" "public.staff_list_received_payments(null, null, null, null, null, null, 100, 0)" \
              "public.staff_list_payments_without_receipt()" "public.get_receipt_settings()" \
              "public.has_later_issued_receipt(current_date - 400, null)" "public.set_document_payment_method('$DOC', 'bit')" \
              "public.mark_payment_receipt_external('account:$PAY', 'x')" "public.staff_session_receipt_roster('$S1')"; do
    out=$(api_as $role "$u" "select ($call)::text;")
    case "$out" in *forbidden*|*"permission denied"*|*not_authorized*|*not_authenticated*|*unauthorized*|false) ok "N $label ${call%%(*} refused";;
      *) fail "N $label ${call%%(*}: $(echo "$out" | head -1 | cut -c1-140)";; esac
  done
done
refused "coach writes a roster rate on another coach's session" "$(api "$C" "insert into public.session_roster_slot_prices (session_id, user_id, price_ils) values ('$S2', '$A', 1); select 1;")"
if [ "$(su -c "select to_regclass('storage.objects') is not null")" = "t" ]; then
  su -c "insert into storage.objects (bucket_id, name, metadata) values ('document-pdfs', 'documents/t163-$n.pdf', '{}'::jsonb)" >/dev/null
  works "manager reads receipt PDFs (storage)" "$(api "$M" "select count(*) from storage.objects where bucket_id = 'document-pdfs';")"
  expect "manager sees the fixture PDF" "1" "$(api "$M" "select count(*) from storage.objects where bucket_id = 'document-pdfs' and name = 'documents/t163-$n.pdf';" | tail -1)"
  refused "coach reads receipt PDFs (storage)" "$(api "$C" "select count(*) from storage.objects where bucket_id = 'document-pdfs';")"
fi
expect "N refused writes left the payment intact" "100.00" "$(su -c "select amount_ils from public.athlete_account_payments where id = '$PAY'")"

echo "== P: legitimate paths still work"
works "manager reads account payments" "$(api "$M" "select count(*) from public.athlete_account_payments;")"
works "manager inserts + updates + deletes an account payment" "$(api "$M" "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at) values ('$A', false, 7, 'cash', current_date); update public.athlete_account_payments set amount_ils = 8 where amount_ils = 7 and payee_id = '$A'; delete from public.athlete_account_payments where amount_ils = 8 and payee_id = '$A'; select 1;")"
for t in documents document_events customers receipt_settings; do works "manager reads $t" "$(api "$M" "select count(*) from public.$t;")"; done
works "manager list_documents" "$(api "$M" "select public.list_documents(null, null, null, null, 10, 0)::text;")"
works "manager staff_list_received_payments" "$(api "$M" "select public.staff_list_received_payments(null, null, null, null, null, null, 100, 0)::text;")"
expect "manager has_later_issued_receipt sees issued receipts" "t" "$(api "$M" "select public.has_later_issued_receipt(current_date - 400, null);" | tail -1)"
works "manager get_receipt_settings" "$(api "$M" "select public.get_receipt_settings()::text;")"
expect "manager create_document" "true" "$( [ -n "$DOC" ] && echo true || echo false)"
works "manager writes studio prices" "$(api "$M" "update public.session_capacity_pricing set price_ils = price_ils where true; select 1;")"
works "coach reads studio prices (amount due at check-in)" "$(api "$C" "select count(*) from public.session_capacity_pricing;")"
works "coach reads per-athlete prices" "$(api "$C" "select count(*) from public.athlete_session_capacity_pricing;")"
expect "coach sees own session roster" "1" "$(api "$C" "select count(*) from public.session_registrations where session_id = '$S1';" | tail -1)"
R=$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'arrived', 'cash', 60, false)::text;")
case "$R" in *'"ok" : true'*|*'"ok":true'*) ok "P coach records attendance + payment at check-in on own session";; *) fail "P coach attendance own session: $R";; esac
R=$(api "$C" "select public.set_registration_attendance('$S2', '$A', 'arrived', 'cash', 60, false)::text;")
case "$R" in *forbidden*) ok "P coach attendance on another coach's session stays refused (pre-existing scope)";; *) fail "P coach attendance other session: $R";; esac
works "coach sets a roster rate on own session" "$(api "$C" "insert into public.session_roster_slot_prices (session_id, user_id, price_ils) values ('$S1', '$A', 70); select 1;")"
expect "coach's own-session rate saved" "70.00" "$(su -c "select price_ils from public.session_roster_slot_prices where session_id = '$S1' and user_id = '$A'")"
works "manager sets a roster rate on any session" "$(api "$M" "insert into public.session_roster_slot_prices (session_id, user_id, price_ils) values ('$S2', '$A', 75) on conflict (session_id, user_id) where user_id is not null do update set price_ils = 75; select 1;")"
works "coach reads athlete profiles for coaching" "$(api "$C" "select count(*) from public.profiles where user_id = '$A';")"

echo
echo "163 coach financial access: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
