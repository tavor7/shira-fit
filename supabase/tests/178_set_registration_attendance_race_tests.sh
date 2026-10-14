#!/usr/bin/env bash
# Real two-connection concurrency regression test for
# 20261019100000_set_registration_attendance_require_active_row.sql.
#
# The bug (found while hardening staff_move_session_participant in 20261018100000, proven here
# with two real, separately-committed connections -- not a sequential approximation):
# set_registration_attendance's initial read already filters `status = 'active'`, but its FINAL
# update targeted the row by id only (`where id = v_row.id`), never re-checking status. Under READ
# COMMITTED, if a concurrent transaction (a move, or an ordinary self-cancellation) changes that
# same row's status to 'cancelled' and commits in the window between this function's initial read
# and its own UPDATE, the UPDATE still matched the row by id regardless of status and silently
# succeeded -- writing attendance/payment fields onto a registration that was no longer active,
# reporting ok:true with nothing to indicate anything was wrong.
#
# Fix: the final UPDATE now requires `and status = 'active'`, so a status change since the initial
# read makes it match zero rows -- already-existing `get diagnostics`/`if v_n = 0` handling then
# refuses the call with 'not_active_registration' instead of returning ok:true.
#
# T1/T2 below reproduce the exact race end to end, BEFORE vs AFTER is documented in the final
# report (not re-derived here -- this file only asserts the fixed, shipping behavior). T3-T9 are
# plain regression checks (unpaid/paid/partial attendance, non-raced cancellation, permissions)
# proving the one-line WHERE-clause change didn't disturb anything else.
#
# Usage (same scratch-schema convention as 177_move_payment_race_tests.sh):
#   PSQL="docker exec -u postgres <container> psql -qAt -v ON_ERROR_STOP=1" \
#   PSQL_ASYNC="docker exec -i <container> psql -U postgres -qAt -v ON_ERROR_STOP=1 -f -" \
#   supabase/tests/178_set_registration_attendance_race_tests.sh
set -u
PSQL=${PSQL:?set PSQL}
PSQL_ASYNC=${PSQL_ASYNC:?set PSQL_ASYNC}
FAILED=0; PASSED=0
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
api() { local uid=$1; local body=$2
  { echo "select set_config('app.current_uid', '$uid', false);"
    printf '%s\n' "$body"; } | $PSQL_ASYNC; }
api_held() { local uid=$1; local body=$2; local delay=$3
  { echo "select set_config('app.current_uid', '$uid', false);"
    echo "begin;"
    printf '%s\n' "$body"
    echo "select pg_sleep($delay);"
    echo "commit;"; } | $PSQL_ASYNC; }

n=$(date +%s%N | tail -c 9)
COACH=$($PSQL -t -A -c "select gen_random_uuid()")
COACH2=$($PSQL -t -A -c "select gen_random_uuid()")
MANAGER=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values
  ('$COACH', 'r178c$n', 'R178 Coach', '0590000001', 'coach', 'approved'),
  ('$COACH2', 'r178c2$n', 'R178 Coach2', '0590000002', 'coach', 'approved'),
  ('$MANAGER', 'r178m$n', 'R178 Manager', '0590000003', 'manager', 'approved')" >/dev/null

echo "== T1: forward race -- move wins the row lock first (unpaid), commits, THEN a concurrent"
echo "   payment call (its own SELECT having read the pre-move active state) attempts its UPDATE =="
ATH=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH', 'r178a$n', 'R178 Athlete', '0590000004', 'athlete', 'approved')" >/dev/null
SRC=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '00:00:01', '$COACH', 6) returning id")
DST=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:59:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC', '$ATH', 'active')" >/dev/null

( api_held "$COACH" "select public.staff_move_session_participant('$SRC'::uuid, '$DST'::uuid, '$ATH'::uuid, null);" 2 > /tmp/178_t1_a.log ) &
APID=$!
sleep 1
R=$(api "$COACH" "select public.set_registration_attendance('$SRC'::uuid, '$ATH'::uuid, 'arrived'::text, 'cash'::text, 100::numeric, false);")
wait $APID
MOVED=$(cat /tmp/178_t1_a.log)
case "$MOVED" in *'"ok" : true'*) ok "T1 move completed (held the lock first): $MOVED" ;; *) fail "T1 move unexpectedly failed: $MOVED" ;; esac
case "$R" in *not_active_registration*) ok "T1 payment call correctly refused, not ok:true: $R" ;; *) fail "T1 expected not_active_registration, got: $R" ;; esac
ROW=$($PSQL -t -A -c "select status || '/' || coalesce(attended::text,'-') || '/' || coalesce(amount_paid::text,'-') || '/' || coalesce(payment_method,'-') from session_registrations where session_id='$SRC' and user_id='$ATH'")
if [ "$ROW" = "cancelled/-/-/-" ]; then ok "T1 cancelled source row left completely untouched: $ROW"; else fail "T1 cancelled source row was modified: $ROW"; fi
DST_COUNT=$($PSQL -t -A -c "select count(*) from session_registrations where session_id='$DST' and user_id='$ATH' and status='active'")
if [ "$DST_COUNT" = "1" ]; then ok "T1 destination registration exists, unaffected by the refused payment write"; else fail "T1 destination registration missing or duplicated"; fi

echo "== T2: fully sequential (no overlap) -- move completes first, THEN a fresh payment call =="
ATH2=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH2', 'r178a2$n', 'R178 Athlete2', '0590000005', 'athlete', 'approved')" >/dev/null
SRC2=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '00:00:03', '$COACH', 6) returning id")
DST2=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:58:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC2', '$ATH2', 'active')" >/dev/null
MOVED2=$(api "$COACH" "select public.staff_move_session_participant('$SRC2'::uuid, '$DST2'::uuid, '$ATH2'::uuid, null);")
case "$MOVED2" in *'"ok" : true'*) ok "T2 setup move completed: $MOVED2" ;; *) fail "T2 setup move failed: $MOVED2" ;; esac
R2=$(api "$COACH" "select public.set_registration_attendance('$SRC2'::uuid, '$ATH2'::uuid, 'arrived'::text, 'cash'::text, 50::numeric, false);")
case "$R2" in *not_active_registration*) ok "T2 sequential (non-overlapping) payment call cleanly refused: $R2" ;; *) fail "T2 expected not_active_registration, got: $R2" ;; esac

echo "== T3: normal attendance update, unpaid (arrived, no payment) still works =="
ATH3=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH3', 'r178a3$n', 'R178 Athlete3', '0590000006', 'athlete', 'approved')" >/dev/null
SRC3=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date + 1, '10:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC3', '$ATH3', 'active')" >/dev/null
R3=$(api "$COACH" "select public.set_registration_attendance('$SRC3'::uuid, '$ATH3'::uuid, 'arrived'::text, null, null, false);")
case "$R3" in *'"ok" : true'*) ok "T3 normal unpaid arrived update works: $R3" ;; *) fail "T3 normal unpaid update failed: $R3" ;; esac
ROW3=$($PSQL -t -A -c "select attended, amount_paid is null, payment_method is null from session_registrations where session_id='$SRC3' and user_id='$ATH3'")
if [ "$ROW3" = "t|t|t" ]; then ok "T3 row state correct: attended=true, unpaid"; else fail "T3 row state wrong: $ROW3"; fi

echo "== T4: normal full payment recording still works =="
R4=$(api "$COACH" "select public.set_registration_attendance('$SRC3'::uuid, '$ATH3'::uuid, 'arrived'::text, 'cash'::text, 120::numeric, false);")
case "$R4" in *'"ok" : true'*) ok "T4 full payment recording works: $R4" ;; *) fail "T4 full payment recording failed: $R4" ;; esac
ROW4=$($PSQL -t -A -c "select amount_paid, payment_method from session_registrations where session_id='$SRC3' and user_id='$ATH3'")
if [ "$ROW4" = "120.00|cash" ]; then ok "T4 full payment persisted: $ROW4"; else fail "T4 full payment not persisted correctly: $ROW4"; fi

echo "== T5: partial payment recording still works =="
R5=$(api "$COACH" "select public.set_registration_attendance('$SRC3'::uuid, '$ATH3'::uuid, 'arrived'::text, 'bit'::text, 30::numeric, false);")
case "$R5" in *'"ok" : true'*) ok "T5 partial payment recording works: $R5" ;; *) fail "T5 partial payment recording failed: $R5" ;; esac
ROW5=$($PSQL -t -A -c "select amount_paid, payment_method from session_registrations where session_id='$SRC3' and user_id='$ATH3'")
if [ "$ROW5" = "30.00|bit" ]; then ok "T5 partial payment persisted: $ROW5"; else fail "T5 partial payment not persisted correctly: $ROW5"; fi

echo "== T6: normal (non-raced) cancellation behavior unaffected -- registration cancelled first"
echo "   (via the same status='cancelled' flip cancel_registration itself performs -- that RPC's"
echo "   own machinery (late-fee policy etc.) is out of scope here; only the resulting row state"
echo "   matters for this check), THEN a fresh attendance/payment call against it is cleanly"
echo "   refused, same as it always has been for a non-overlapping, already-cancelled registration =="
ATH6=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH6', 'r178a6$n', 'R178 Athlete6', '0590000007', 'athlete', 'approved')" >/dev/null
SRC6=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date + 2, '11:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC6', '$ATH6', 'active')" >/dev/null
$PSQL -c "update session_registrations set status = 'cancelled' where session_id = '$SRC6' and user_id = '$ATH6'" >/dev/null
R6=$(api "$COACH" "select public.set_registration_attendance('$SRC6'::uuid, '$ATH6'::uuid, 'arrived'::text, 'cash'::text, 10::numeric, false);")
case "$R6" in *not_active_registration*) ok "T6 attendance call against an already-cancelled registration cleanly refused: $R6" ;; *) fail "T6 expected not_active_registration, got: $R6" ;; esac

echo "== T7: manager and coach permissions on set_registration_attendance unchanged =="
ATH7=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH7', 'r178a7$n', 'R178 Athlete7', '0590000008', 'athlete', 'approved')" >/dev/null
SRC7=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date + 3, '12:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC7', '$ATH7', 'active')" >/dev/null
R7M=$(api "$MANAGER" "select public.set_registration_attendance('$SRC7'::uuid, '$ATH7'::uuid, 'arrived'::text, 'cash'::text, 15::numeric, false);")
case "$R7M" in *'"ok" : true'*) ok "T7 manager can record payment on any coach's session: $R7M" ;; *) fail "T7 manager permission regressed: $R7M" ;; esac
R7C2=$(api "$COACH2" "select public.set_registration_attendance('$SRC7'::uuid, '$ATH7'::uuid, 'arrived'::text, 'cash'::text, 15::numeric, false);")
case "$R7C2" in *forbidden*) ok "T7 a coach who does not own the session is still forbidden: $R7C2" ;; *) fail "T7 expected forbidden for a non-owning coach, got: $R7C2" ;; esac
R7C1=$(api "$COACH" "select public.set_registration_attendance('$SRC7'::uuid, '$ATH7'::uuid, 'absent'::text, null, null, false);")
case "$R7C1" in *'"ok" : true'*) ok "T7 the session's own coach can still record attendance: $R7C1" ;; *) fail "T7 owning-coach permission regressed: $R7C1" ;; esac

echo "== T8: manual participants completely unaffected (different table, different function) =="
MP8=$($PSQL -t -A -c "insert into public.manual_participants (full_name, phone) values ('R178 Manual', '0590000009$n') returning id")
SRC8=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date + 4, '13:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$SRC8', '$MP8')" >/dev/null
R8=$(api "$COACH" "select public.set_manual_participant_attendance('$SRC8'::uuid, '$MP8'::uuid, 'arrived'::text, 'cash'::text, 40::numeric, false);")
case "$R8" in *'"ok" : true'*) ok "T8 manual participant attendance/payment unaffected: $R8" ;; *) fail "T8 manual participant path regressed: $R8" ;; esac

echo "== T9: future-session move still works (roster_locked path untouched, this migration never"
echo "   touches staff_move_session_participant) =="
ATH9=$($PSQL -t -A -c "select gen_random_uuid()")
$PSQL -c "insert into public.profiles (user_id, username, full_name, phone, role, approval_status) values ('$ATH9', 'r178a9$n', 'R178 Athlete9', '0590000010', 'athlete', 'approved')" >/dev/null
SRC9=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:55:00', '$COACH', 6) returning id")
DST9=$($PSQL -t -A -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values (current_date, '23:56:00', '$COACH', 6) returning id")
$PSQL -c "insert into public.session_registrations (session_id, user_id, status) values ('$SRC9', '$ATH9', 'active')" >/dev/null
R9=$(api "$COACH" "select public.staff_move_session_participant('$SRC9'::uuid, '$DST9'::uuid, '$ATH9'::uuid, null);")
case "$R9" in *'"ok" : true'*) ok "T9 future-session unpaid move still works: $R9" ;; *) fail "T9 future-session move regressed: $R9" ;; esac

echo "== Summary: $PASSED passed, $FAILED failed =="
if [ "$FAILED" -gt 0 ]; then exit 1; fi
