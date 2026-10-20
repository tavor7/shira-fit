#!/usr/bin/env bash
# Regression test for 20261023120000_guard_delete_receipted_sessions.sql.
#
# Real `authenticator` connections. Fixture: manager M, coach C, athlete A.
#   B  baseline: a session with no receipted payment deletes normally (direct delete, and via
#      staff_delete_session_series_scope)
#   R  a session with a receipted REGISTRATION payment cannot be deleted: not directly, not via
#      staff_delete_session_series_scope (single, series scope 'this', series scope 'future' -- and scope
#      'future' leaves session_series.status unchanged, proving the whole call rolled back atomically),
#      not via manager_clear_sessions_for_day (bulk), and the rest of that day's sessions are untouched too
#   MP a session with a receipted MANUAL PARTICIPANT payment is equally protected
#   V  a registration that was cancelled AFTER being receipted (status no longer 'active', payment fields
#      untouched -- the guard does not rely on registration status) still blocks deletion, including through
#      manager_revert_activity_event's 'session_created' undo path, which has its own pre-existing
#      "no active registrations/participants" check that this scenario deliberately slips past
#   F  false positives avoided: an unrelated account payment for the same athlete does not block; a receipt
#      for a DIFFERENT session does not block THIS session's deletion
#   X  cancelling the receipt unlocks the session for deletion again
#   C  concurrency: a receipt being issued concurrently cannot be raced past by a delete
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/181_delete_receipted_session_guard_tests.sh   (SCRATCH/LOCAL ONLY)
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
locked()  { case "$2" in *session_has_receipted_payment*|*session_payment_has_receipt_history*) ok "$1 (refused: receipt issued)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
allowed() { case "$2" in *session_has_receipted_payment*|*session_payment_has_receipt_history*|*ERROR*) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; *) ok "$1";; esac; }
history_locked() { case "$2" in *session_payment_has_receipt_history*) ok "$1 (refused: has receipt history, even though the receipt is now cancelled)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
exists_sess() { su -c "select count(*) from public.training_sessions where id = '$1'"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f181-$n-m@t.local', '051$n'), ('$C'::uuid, 'f181-$n-c@t.local', '052$n'), ('$A'::uuid, 'f181-$n-a@t.local', '053$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null

su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-181') where true" >/dev/null
DAY=$(su -c "select (current_date + 10)::text")

echo "== B: baseline -- a clean session deletes normally"
S0=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '06:00', '$C', 6, true) returning id" | head -1)
allowed "B direct delete of an unreceipted session" "$(api "$M" "delete from public.training_sessions where id = '$S0'; select 1;")"
[ "$(exists_sess $S0)" = "0" ] && ok "B session actually gone" || fail "B session still exists"
S0b=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '06:15', '$C', 6, true) returning id" | head -1)
allowed "B staff_delete_session_series_scope on an unreceipted single session" "$(api "$M" "select public.staff_delete_session_series_scope('$S0b', 'this')::text;")"
[ "$(exists_sess $S0b)" = "0" ] && ok "B session actually gone (RPC path)" || fail "B session still exists (RPC path)"

echo "== R: a session with a receipted registration payment cannot be deleted"
S1=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '07:00', '$C', 6, true) returning id" | head -1)
REG1=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S1', '$A', 'active', true, 'cash', 80) returning id" | head -1)
R=$(api "$M" "select public.create_document(80, 'other', 'Customer 181', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG1', 'cash')::text;")
case "$R" in *'"ok" : true'*) ok "R manager issues a receipt for the registration payment";; *) fail "R issue receipt: $R";; esac
locked "R direct table delete" "$(api "$M" "delete from public.training_sessions where id = '$S1'; select 1;")"
locked "R staff_delete_session_series_scope (single)" "$(api "$M" "select public.staff_delete_session_series_scope('$S1', 'this')::text;")"
[ "$(exists_sess $S1)" = "1" ] && ok "R session still exists after all refusals" || fail "R session is gone"

echo "== R: series scope 'this' and 'future' are also refused, atomically"
SER=$(su -c "insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants, is_open_for_registration, repeat_mode, roster_policy, status) values (gen_random_uuid(), '$C', '$DAY', '07:00', 60, 6, true, 'ongoing', 'none', 'active') returning id" | head -1)
su -c "update public.training_sessions set series_id = '$SER' where id = '$S1'" >/dev/null
locked "R series scope 'this'" "$(api "$M" "select public.staff_delete_session_series_scope('$S1', 'this')::text;")"
STATUS_BEFORE=$(su -c "select status from public.session_series where id = '$SER'")
locked "R series scope 'future'" "$(api "$M" "select public.staff_delete_session_series_scope('$S1', 'future')::text;")"
STATUS_AFTER=$(su -c "select status from public.session_series where id = '$SER'")
expect "R scope 'future' rolled back fully (session_series.status unchanged)" "$STATUS_BEFORE" "$STATUS_AFTER"
[ "$(exists_sess $S1)" = "1" ] && ok "R session still exists after series-scope refusals" || fail "R session is gone"

echo "== R: bulk day-clear refuses the whole day when one session is protected, and nothing on that day is touched"
S2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '08:00', '$C', 6, true) returning id" | head -1)
BEFORE_COUNT=$(su -c "select count(*) from public.training_sessions where session_date = '$DAY'")
R=$(api "$M" "select public.manager_clear_sessions_for_day('$DAY')::text;")
case "$R" in *session_has_receipted_payment*) ok "R manager_clear_sessions_for_day refuses the whole day";; *) fail "R bulk clear: $R";; esac
AFTER_COUNT=$(su -c "select count(*) from public.training_sessions where session_date = '$DAY'")
expect "R no session on that day was deleted (atomic, including the unrelated S2)" "$BEFORE_COUNT" "$AFTER_COUNT"
[ "$(exists_sess $S2)" = "1" ] && ok "R the unrelated same-day session S2 is untouched" || fail "R S2 was deleted despite being unrelated"
DOC1=$(su -c "select id from public.documents where source_id = '$REG1' and status <> 'CANCELLED' limit 1")

echo "== MP: a receipted manual participant equally protects the session"
S3=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '09:00', '$C', 6, true) returning id" | head -1)
MPID=$(su -c "insert into public.manual_participants (full_name, phone) values ('mp181 $n', '054$n') returning id" | head -1)
SMP=$(su -c "insert into public.session_manual_participants (session_id, manual_participant_id, attended, payment_method, amount_paid) values ('$S3', '$MPID', true, 'cash', 40) returning id" | head -1)
api "$M" "select public.create_document(40, 'other', 'Customer 181 MP', null, null, 'cash', 'svc', null, null, '$MPID', 'session_payment', '$SMP', 'cash')::text;" >/dev/null
locked "MP direct delete of session with receipted manual participant" "$(api "$M" "delete from public.training_sessions where id = '$S3'; select 1;")"

echo "== V: a receipted registration that is no longer 'active' still blocks the session_created revert path"
S4=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '10:00', '$C', 6, true) returning id" | head -1)
REG4=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S4', '$A', 'active', true, 'cash', 50) returning id" | head -1)
api "$M" "select public.create_document(50, 'other', 'Customer 181 V', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG4', 'cash')::text;" >/dev/null
su -c "update public.session_registrations set status = 'cancelled' where id = '$REG4'" >/dev/null
INFO=$(su -c "select public.manager_activity_revert_info(gen_random_uuid())::text")  # sanity: function exists
EVT=$(su -c "insert into public.user_activity_events (actor_user_id, event_type, target_type, target_id, metadata) values ('$M', 'session_created', 'session', '$S4', '{}'::jsonb) returning id" | head -1)
R=$(api "$M" "select public.manager_activity_revert_info('$EVT')::text;")
case "$R" in *'"can_revert" : true'*) ok "V pre-existing check (no active registrations) would otherwise allow the revert -- confirms this scenario really tests the new guard, not the old check";; *) fail "V revert_info unexpectedly refuses already: $R (test fixture needs adjusting)";; esac
R=$(api "$M" "select public.manager_revert_activity_event('$EVT')::text;")
locked "V manager_revert_activity_event('session_created') is refused by the new guard" "$R"
[ "$(exists_sess $S4)" = "1" ] && ok "V session still exists after the revert attempt" || fail "V session is gone -- the revert path bypassed the guard"

echo "== F: false positives avoided"
S5=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '11:00', '$C', 6, true) returning id" | head -1)
su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 300, 'cash', current_date, '$M')" >/dev/null
allowed "F unrelated account payment for the same athlete does not block S5" "$(api "$M" "delete from public.training_sessions where id = '$S5'; select 1;")"
[ "$(exists_sess $S5)" = "0" ] && ok "F S5 actually deleted" || fail "F S5 still exists"
S6=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '12:00', '$C', 6, true) returning id" | head -1)
allowed "F a receipt on a DIFFERENT session (S1/REG1) does not block S6" "$(api "$M" "delete from public.training_sessions where id = '$S6'; select 1;")"
[ "$(exists_sess $S6)" = "0" ] && ok "F S6 actually deleted" || fail "F S6 still exists"

echo "== X: cancelling the receipt no longer unlocks deletion (2026-10-22: once receipted, always protected)"
R=$(api "$M" "select public.cancel_document('$DOC1', 'test 181', false)::text;")
case "$R" in *'"ok" : true'*) ok "X manager cancels the receipt for REG1/S1";; *) fail "X cancel: $R";; esac
history_locked "X S1 still cannot be deleted (REG1 has receipt history, even though the receipt is cancelled)" "$(api "$M" "delete from public.training_sessions where id = '$S1'; select 1;")"
[ "$(exists_sess $S1)" = "1" ] && ok "X S1 still exists (permanently protected once it ever had a receipt)" || fail "X S1 is gone"

echo "== C: concurrent receipt issuance cannot be bypassed by a racing delete"
S7=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$DAY', '13:00', '$C', 6, true) returning id" | head -1)
REG7=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended, payment_method, amount_paid) values ('$S7', '$A', 'active', true, 'cash', 60) returning id" | head -1)
( { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$M\",\"role\":\"authenticated\"}';
    select public.create_document(60, 'other', 'Customer 181 C', null, null, 'cash', 'svc', null, '$A', null, 'session_payment', '$REG7', 'cash');
    select pg_sleep(3); commit;"; } | $PSQL_AUTH -qAt > /tmp/181_issue.log 2>&1 ) &
sleep 1
OUT=$(api "$M" "delete from public.training_sessions where id = '$S7'; select 1;" 2>&1)
wait
case "$OUT" in *session_has_receipted_payment*) ok "C delete issued while the receipt was being created waits, then is refused";; *) fail "C concurrent: $(echo "$OUT" | head -1 | cut -c1-160)";; esac
[ "$(exists_sess $S7)" = "1" ] && ok "C session survived the race" || fail "C session was deleted despite the race guard"
N=$(su -c "select count(*) from public.documents where source_id = '$REG7' and status <> 'CANCELLED'")
[ "$N" = "1" ] && ok "C exactly one receipt exists for the payment" || fail "C expected 1 receipt, got $N"

echo
echo "181 delete-receipted-session guard: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
