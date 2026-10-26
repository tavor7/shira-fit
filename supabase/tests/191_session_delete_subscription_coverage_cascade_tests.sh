#!/usr/bin/env bash
# Regression test for 20261026160000_fix_subscription_registration_coverage_hard_delete_guard.sql.
#
# Bug: 20261023130000_guard_subscription_hard_delete.sql put a BEFORE DELETE guard on
# subscription_registration_coverage and subscription_impact_event_registrations, missing that both
# are (and always were) `on delete cascade` from session_registrations/session_manual_participants.
# Deleting ANY session with a subscription-covered participant therefore failed with
# "subscription_record_immutable" (reproduced in production: the 2026-10-26 08:30 session), because
# the cascade from `delete from training_sessions` hit the guard on the coverage row.
#
# Drives the REAL staff_delete_session_series_scope RPC over an `authenticator` connection as
# `authenticated` with JWT claims, exactly like PostgREST -- same harness as 159/182.
#
# Scenarios
#   A  a session with NO subscription coverage deletes fine (sanity -- this always worked)
#   B  a session WITH a subscription-covered registration (the actual bug) now deletes successfully,
#      and its coverage row is gone too (real cascade, not silently orphaned)
#   C  the subscription's own financial ledger (subscription_charges, subscription_billing_periods,
#      subscription_versions) is completely untouched by B -- deleting a session must never reverse,
#      alter or remove a single ledger row
#   D  the six money-bearing tables are still fully guarded against a direct hard DELETE (unaffected
#      by this fix) -- a lighter spot check than 182's, which covers this exhaustively
#   E  a receipted session (issued receipt on a payment for it) is STILL refused, unaffected by this
#      fix -- the pre-existing session_has_receipted_payment guard (20261023120000) is a different
#      trigger entirely and this migration does not touch it
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/191_session_delete_subscription_coverage_cascade_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users, sessions and a subscription. Never run it against production.
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
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
refused() { case "$2" in *subscription_record_immutable*) ok "$1 (refused, as expected)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
refused_receipt() { case "$2" in *session_has_receipted_payment*) ok "$1 (refused, as expected)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
succeeded() { case "$2" in *subscription_record_immutable*|*ERROR*) fail "$1: $(echo "$2" | head -1 | cut -c1-200)";; *'"ok" : true'*) ok "$1";; *) fail "$1 (no ok:true): $(echo "$2" | head -1 | cut -c1-160)";; esac; }
ledger_fp() { su -c "select
  (select count(*)||':'||coalesce(sum(amount_ils),0) from public.subscription_charges where subscription_id='$1') || '|' ||
  (select count(*) from public.subscription_billing_periods where subscription_id='$1') || '|' ||
  (select count(*) from public.subscription_versions where subscription_id='$1')"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()"); CO=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f191-$n-m@t.local', '061$n'), ('$A'::uuid, 'f191-$n-a@t.local', '062$n'), ('$CO'::uuid, 'f191-$n-c@t.local', '063$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A','$CO');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$CO'" >/dev/null

echo "== setup: a real subscription with an immediate charge, and two future sessions"
R=$(api "$M" "select public.create_subscription('$A', false, 300, current_date, null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
case "$R" in *'"ok" : true'*) ok "setup: create_subscription succeeded";; *) fail "setup create_subscription: $R"; echo "191 ABORTED: fixture failed"; exit 1;; esac
SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false order by created_at desc limit 1")
VER=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB' limit 1")
FP0=$(ledger_fp "$SUB")

SX_NO_SUB=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 20, '08:00', '$CO', 6, true) returning id" | head -1)
SX_SUB=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 20, '08:30', '$CO', 6, true) returning id" | head -1)
SX_RECEIPT=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 20, '09:00', '$CO', 6, true) returning id" | head -1)

echo "== A: a session with NO subscription coverage deletes fine (sanity)"
REG_PLAIN=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$SX_NO_SUB', '$A', 'active') returning id" | head -1)
succeeded "A delete of a session with a plain (non-subscription) registration" "$(api "$M" "select public.staff_delete_session_series_scope('$SX_NO_SUB', 'this')::text;")"
expect "A session row is gone" "0" "$(su -c "select count(*) from public.training_sessions where id='$SX_NO_SUB'")"

echo "== B: a session WITH a subscription-covered registration (the actual reported bug) now deletes successfully"
REG_SUB=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$SX_SUB', '$A', 'active') returning id" | head -1)
COV=$(su -c "insert into public.subscription_registration_coverage (subscription_id, version_id, registration_id, session_date, week_start, tier, covered, decided_by) values ('$SUB', '$VER', '$REG_SUB', current_date + 20, (current_date + 20) - extract(dow from current_date + 20)::int, 'group', true, 'registration') returning id" | head -1)
[ -n "$COV" ] && ok "B coverage fixture row created" || fail "B coverage fixture insert failed"
succeeded "B delete of a session with a subscription-covered registration" "$(api "$M" "select public.staff_delete_session_series_scope('$SX_SUB', 'this')::text;")"
expect "B session row is gone" "0" "$(su -c "select count(*) from public.training_sessions where id='$SX_SUB'")"
expect "B registration cascaded away" "0" "$(su -c "select count(*) from public.session_registrations where id='$REG_SUB'")"
expect "B coverage row cascaded away with it (real cascade, not orphaned)" "0" "$(su -c "select count(*) from public.subscription_registration_coverage where id='$COV'")"

echo "== C: the subscription's financial ledger is completely untouched by the session delete in B"
expect "C ledger fingerprint unchanged (charges:amount|billing_periods|versions)" "$FP0" "$(ledger_fp "$SUB")"

echo "== D: the six money-bearing tables are still fully guarded (spot check; 182 covers this exhaustively)"
BP=$(su -c "select id from public.subscription_billing_periods where subscription_id='$SUB' limit 1")
CHG=$(su -c "select id from public.subscription_charges where subscription_id='$SUB' limit 1")
[ -n "$BP" ] && refused "D subscription_billing_periods still refuses a direct hard delete" "$(api "$M" "delete from public.subscription_billing_periods where id = '$BP'; select 1;")"
[ -n "$CHG" ] && refused "D subscription_charges still refuses a direct hard delete" "$(api "$M" "delete from public.subscription_charges where id = '$CHG'; select 1;")"
refused "D subscription_versions still refuses a direct hard delete" "$(api "$M" "delete from public.subscription_versions where id = '$VER'; select 1;")"
refused "D subscriptions still refuses a direct hard delete" "$(api "$M" "delete from public.subscriptions where id = '$SUB'; select 1;")"

echo "== E: a session with a receipted payment is still refused (different, pre-existing guard; unaffected by this fix)"
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-191') where true" >/dev/null
REG_RECEIPT=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$SX_RECEIPT', '$A', 'active', true, 'cash', 80) returning id" | head -1)
DOCR=$(api "$M" "select public.create_document(80, 'other', 'Customer 191', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG_RECEIPT', 'cash')::text;")
case "$DOCR" in *'"ok" : true'*) ok "E manager issues a receipt for the registration payment"
  refused_receipt "E delete of a session with an issued receipt" "$(api "$M" "select public.staff_delete_session_series_scope('$SX_RECEIPT', 'this')::text;")";;
*) echo "  SKIPPED: E (create_document fixture call failed in this schema snapshot: $DOCR) -- covered independently by 181";;
esac

echo
echo "191 session delete / subscription coverage cascade: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
