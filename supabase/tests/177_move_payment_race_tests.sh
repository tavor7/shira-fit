#!/usr/bin/env bash
# Real two-connection concurrency regression test for
# 20261018100000_move_session_participant_lock_payment_row.sql.
#
# The bug this guards against (proven while developing that migration, with two separate,
# explicitly-committed connections and pg_stat_activity evidence of the lock wait -- not just a
# sequential approximation): staff_move_session_participant's initial read of the participation row
# (session_registrations / session_manual_participants) took no lock. Under READ COMMITTED, that
# read only ever sees the last COMMITTED version -- so if a concurrent payment-recording call
# (set_registration_attendance / set_manual_participant_attendance, or a direct table UPDATE) had
# started writing the SAME row but not committed yet, the move's payment check read the OLD
# (unpaid) value and passed, and the move's own later UPDATE/DELETE on that row (which never
# re-checks payment) still went through once the writer committed. Observed outcomes before the
# fix: athlete branch -- the move committed (ok:true), the $100 payment landed on the now-cancelled
# source row (payment silently orphaned, invisible as "paid" on an active registration); manual-
# participant branch -- worse: the move's hard DELETE erased the row entirely, permanently losing
# the $80 payment that had just been committed on it, while the move itself reported ok:true.
#
# The fix adds `for update` on that same row at the point it is first read (before the payment
# check), in both branches. This closes the race against EVERY writer of that row (the attendance
# RPCs, a direct PostgREST table update, or a receipt being issued -- receipt issuance already
# takes `for update` on this exact row before inserting into documents/external_manual_receipts,
# per 20261013140000_lock_receipted_session_payments_for_coaches.sql's own design, so the move now
# simply participates in that same established protocol) because Postgres row-level locking
# applies to the row itself, regardless of which statement or caller is touching it.
#
# This harness uses `set_config('app.current_uid', ...)` to simulate auth.uid(), matching the
# convention already used by this repo's other staff_move_session_participant tests
# (30_move_bypass_tests.sql, 40-42_move_concurrency_*.sql, 176_move_past_session_unpaid_tests.sql)
# against the 00/01 stub schema -- not the JWT-role-switching convention used by tests written
# against a fully-migrated real schema (e.g. 164_receipted_session_payment_lock_tests.sh), which
# this repo's stub schema does not implement (see 00_stub_schema.sql's header for why a full
# `supabase db reset` cannot be used here).
#
# Expected: the move blocks until the payment transaction commits, then correctly refuses with
# payment_recorded, and the row is left exactly as the payment left it.
#
# R3 (the reverse order -- the move wins the row lock first) additionally exercises the companion
# fix in 20261019100000_set_registration_attendance_require_active_row.sql: a payment write that
# loses that race must now be refused (not_active_registration), not silently succeed onto the
# row the move just cancelled. See that migration's header and
# supabase/tests/178_set_registration_attendance_race_tests.sh for the full story.
#
# Usage (against the scratch Postgres this repo's stub-schema tests are run on -- see
# 10_phase1_2_scoped_tests.sql's header for the exact migration load order):
#   PSQL="docker exec -u postgres <container> psql -qAt -v ON_ERROR_STOP=1" \
#   PSQL_ASYNC="docker exec -i <container> psql -U postgres -qAt -v ON_ERROR_STOP=1 -f -" \
#   supabase/tests/177_move_payment_race_tests.sh
set -u
PSQL=${PSQL:?set PSQL}
PSQL_ASYNC=${PSQL_ASYNC:?set PSQL_ASYNC}
FAILED=0; PASSED=0
su() { $PSQL -c "$1"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
# One call, one transaction, auto-committed (like a single PostgREST request).
api() { local uid=$1; local body=$2
  { echo "select set_config('app.current_uid', '$uid', false);"
    printf '%s\n' "$body"; } | $PSQL_ASYNC; }
# Same, but the transaction is explicitly held open past its own write for `delay` seconds before
# committing -- simulates a payment-recording (or a move) call that is genuinely still in flight.
api_held() { local uid=$1; local body=$2; local delay=$3
  { echo "select set_config('app.current_uid', '$uid', false);"
    echo "begin;"
    printf '%s\n' "$body"
    echo "select pg_sleep($delay);"
    echo "commit;"; } | $PSQL_ASYNC; }

n=$(date +%s%N | tail -c 9)
COACH=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$COACH', 'race177c$n', 'Race Coach 177', '0530000001', 'coach', 'approved')" >/dev/null

echo "== R1: registered-athlete branch -- payment commits mid-race, move must block then refuse =="
ATH=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH', 'race177a$n', 'Race Athlete 177', '0530000002', 'athlete', 'approved')" >/dev/null
SRC=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '00:00:01', '$COACH', 6) returning id")
DST=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:59:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC', '$ATH', 'active')" >/dev/null

( api_held "$COACH" "select public.set_registration_attendance('$SRC'::uuid, '$ATH'::uuid, 'arrived'::text, 'cash'::text, 100::numeric, false);" 2 > /tmp/177_r1_a.log ) &
APID=$!
sleep 1
R=$(api "$COACH" "select public.staff_move_session_participant('$SRC'::uuid, '$DST'::uuid, '$ATH'::uuid, null);")
wait $APID
case "$R" in
  *payment_recorded*) ok "R1 move correctly blocked until the payment committed, then refused (payment_recorded): $R" ;;
  *) fail "R1 expected payment_recorded after blocking, got: $R" ;;
esac
ROW=$($PSQL -t -A -c "select status || '/' || coalesce(attended::text,'-') || '/' || coalesce(amount_paid::text,'-') || '/' || coalesce(payment_method,'-') from session_registrations where session_id='$SRC' and user_id='$ATH'")
case "$ROW" in
  active/true/100.00/cash) ok "R1 source row left exactly as the payment left it (active, paid): $ROW" ;;
  *) fail "R1 source row corrupted or payment lost: $ROW" ;;
esac
DST_COUNT=$($PSQL -t -A -c "select count(*) from session_registrations where session_id='$DST' and user_id='$ATH'")
if [ "$DST_COUNT" = "0" ]; then ok "R1 destination untouched"; else fail "R1 destination unexpectedly gained a registration despite the refusal"; fi

echo "== R2: manual-participant branch -- payment commits mid-race, move must block then refuse =="
MP=$($PSQL -t -A -c "insert into public.manual_participants (full_name, phone) values ('Race MP 177', '0530000003$n') returning id")
SRC2=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '00:00:05', '$COACH', 6) returning id")
DST2=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:58:00', '$COACH', 6) returning id")
SMP=$($PSQL -t -A -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$SRC2', '$MP') returning id")

( api_held "$COACH" "select public.set_manual_participant_attendance('$SRC2'::uuid, '$MP'::uuid, 'arrived'::text, 'bit'::text, 80::numeric, false);" 2 > /tmp/177_r2_a.log ) &
APID=$!
sleep 1
R=$(api "$COACH" "select public.staff_move_session_participant('$SRC2'::uuid, '$DST2'::uuid, null, '$MP'::uuid);")
wait $APID
case "$R" in
  *payment_recorded*) ok "R2 move correctly blocked until the payment committed, then refused (payment_recorded): $R" ;;
  *) fail "R2 expected payment_recorded after blocking, got: $R" ;;
esac
SURVIVES=$($PSQL -t -A -c "select count(*) from session_manual_participants where id='$SMP' and attended=true and amount_paid=80.00 and payment_method='bit'")
if [ "$SURVIVES" = "1" ]; then ok "R2 source manual-participant row survives intact (not deleted, payment preserved)"; else fail "R2 source manual-participant row was deleted or corrupted -- payment data lost"; fi
DST2_COUNT=$($PSQL -t -A -c "select count(*) from session_manual_participants where session_id='$DST2' and manual_participant_id='$MP'")
if [ "$DST2_COUNT" = "0" ]; then ok "R2 destination untouched"; else fail "R2 destination unexpectedly gained a registration despite the refusal"; fi

echo "== R3: reverse order -- move wins the row lock first (unpaid); a concurrent payment attempt"
echo "   for the SAME row waits behind it instead of interleaving undetected =="
ATH3=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH3', 'race177a3$n', 'Race Athlete 3 177', '0530000004', 'athlete', 'approved')" >/dev/null
SRC3=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '00:00:09', '$COACH', 6) returning id")
DST3=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:57:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC3', '$ATH3', 'active')" >/dev/null

( api_held "$COACH" "select public.staff_move_session_participant('$SRC3'::uuid, '$DST3'::uuid, '$ATH3'::uuid, null);" 2 > /tmp/177_r3_a.log ) &
APID=$!
sleep 1
R=$(api "$COACH" "select public.set_registration_attendance('$SRC3'::uuid, '$ATH3'::uuid, 'arrived'::text, 'cash'::text, 50::numeric, false);")
wait $APID
MOVED=$(cat /tmp/177_r3_a.log)
case "$MOVED" in *'"ok" : true'*) ok "R3 unpaid move completed (it held the lock first): $MOVED" ;; *) fail "R3 move unexpectedly failed: $MOVED" ;; esac
# As of 20261019100000_set_registration_attendance_require_active_row.sql, the payment write's
# final UPDATE now requires `and status = 'active'`, so losing the race (the row was cancelled by
# the move while this call's own initial SELECT had already read it as active) makes the UPDATE
# match zero rows instead of silently succeeding onto the now-cancelled row. Before that fix this
# assertion expected ok:true (the payment landing, undetected, on the cancelled row) -- see that
# migration's header and supabase/tests/178_set_registration_attendance_race_tests.sh for the bug
# this closes. The destination itself must remain untouched regardless.
case "$R" in *not_active_registration*) ok "R3 payment write correctly refused after losing the race: $R" ;; *) fail "R3 expected not_active_registration after losing the race, got: $R" ;; esac
UNTOUCHED=$($PSQL -t -A -c "select count(*) from session_registrations where session_id='$SRC3' and user_id='$ATH3' and status='cancelled' and amount_paid is null and attended is null")
if [ "$UNTOUCHED" = "1" ]; then ok "R3 cancelled source row left untouched by the refused payment write"; else fail "R3 cancelled source row was modified by the refused payment write"; fi
LEAKED=$($PSQL -t -A -c "select count(*) from session_registrations where session_id='$DST3' and user_id='$ATH3' and amount_paid is not null")
if [ "$LEAKED" = "0" ]; then ok "R3 destination registration unaffected by the late payment write"; else fail "R3 the late payment leaked onto the destination registration"; fi

echo "== Summary: $PASSED passed, $FAILED failed =="
if [ "$FAILED" -gt 0 ]; then exit 1; fi
