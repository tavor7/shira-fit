#!/usr/bin/env bash
# System monitoring Phase 2.2: REAL concurrency / isolation tests for the job observer (separate connections).
#
#   D1  overlapping observers: while one holds the observer lock the other returns {"skipped":true} at once;
#       N observers released together never error and never double-count
#   D2  monitor-table lock contention: an observer blocked on public.system_job_state gives up within about
#       lock_timeout (1 s) and raises, while the business cron functions run unaffected, unblocked and fast
#   D3  (same run) the business functions' outcome is identical with and without the observer failing
#   D4  the observer never writes outside system_job_state (cron.job, issues, events, profiles, sessions, pg_net queue)
#   D5  a natural pg_cron execution of the observer (if the scheduler runs in this database) succeeds
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/145_system_job_observer_concurrency.sh
# Requires the Phase 2.1-2.3 migrations. Side effects: the business cron functions are executed (use only on a
# scratch/local database, NEVER against production).
set -u
PSQL=${PSQL:?set PSQL to a psql command line}
TMP=$(mktemp -d)
LOCKKEY=7145001
FAILED=0
PASSED=0

q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "$1"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }

# deterministic start: reset the observer's own bookkeeping
q "update public.system_job_state set cursor='{}', last_run_id=0, runs_observed=0, last_started_at=null, last_finished_at=null,
   last_technical_success_at=null, last_failure_at=null, last_status=null, last_technical_outcome='unknown', last_outcome='unknown',
   consecutive_failures=0, consecutive_ok=0, last_duration_ms=null, last_result='{}', stale=false, stale_since=null, shadow='{}',
   last_observed_at=null, grace_until=null;" >/dev/null

echo "D1: overlapping observers"
( $PSQL -qAt -c "begin; select pg_advisory_xact_lock(hashtext('shira.system_job_observe')); select pg_sleep(3); commit;" >/dev/null 2>&1 ) &
HOLD=$!
sleep 1
R=$(q "select public._system_job_observe()")
if echo "$R" | grep -q '"skipped" *: *true'; then ok "a second observer skips while the first is running: $R"; else fail "second observer did not skip: $R"; fi
wait $HOLD

q "select public._system_job_observe()" >/dev/null   # bootstrap once
for i in 1 2 3 4 5 6; do
  ( $PSQL -qAt -c "select pg_advisory_lock_shared($LOCKKEY); select public._system_job_observe();" > $TMP/d1_$i.out 2>$TMP/d1_$i.err ) &
done
sleep 1
$PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(0.3); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1
wait
ERRS=$(cat $TMP/d1_*.err | grep -ci 'error')
expect "no observer errored when 6 start together" 0 "$ERRS"
RAN=$(cat $TMP/d1_*.out | grep -c '"ok" *: *true')
if [ "$RAN" -ge 1 ]; then ok "at least one observer completed ($RAN of 6 returned ok; the others skipped)"; else fail "no observer completed"; fi
BAD=$(q "select count(*) from public.system_job_state s join cron.job j on j.jobname = s.job_key
         where s.runs_observed > (select count(*) from cron.job_run_details d where d.jobid = j.jobid)")
expect "no job counted more runs than exist in cron history" 0 "$BAD"

echo "D2/D3: lock contention on the monitoring table; business functions unaffected"
baseline() {
  for f in "public.send_due_birthday_messages()" "public.enqueue_due_session_reminder_whatsapp()" "public.open_next_week_sessions_if_due_core()"; do
    S=$(now_ms)
    OUT=$($PSQL -qAt -c "select $f" 2>&1 | head -c 200 | tr '\n' ' ')
    E=$(now_ms)
    echo "$f|$(echo "$OUT" | cut -c1-80)|$((E-S))"
  done
}
baseline > $TMP/base_free.txt
( $PSQL -qAt -c "begin; lock table public.system_job_state in access exclusive mode; select pg_sleep(4); commit;" >/dev/null 2>&1 ) &
LOCKER=$!
sleep 1
S=$(now_ms)
OBS=$($PSQL -qAt -c "select public._system_job_observe()" 2>&1)
E=$(now_ms)
OBS_MS=$((E-S))
if echo "$OBS" | grep -qi 'lock timeout\|could not obtain lock\|canceling statement'; then ok "blocked observer gives up with a lock error: $(echo $OBS | cut -c1-80)"; else fail "blocked observer did not fail on lock timeout: $OBS"; fi
if [ "$OBS_MS" -lt 2500 ]; then ok "blocked observer gave up in ${OBS_MS} ms (lock_timeout = 1 s)"; else fail "blocked observer waited ${OBS_MS} ms"; fi
baseline > $TMP/base_locked.txt
wait $LOCKER
D2FAIL=0
while IFS='#' read -r a b; do
  fa=$(echo "$a" | cut -d'|' -f1,2); fb=$(echo "$b" | cut -d'|' -f1,2); ms=$(echo "$b" | cut -d'|' -f3)
  if [ "$fa" = "$fb" ]; then echo "  ok: ${fa%%|*} outcome identical with the monitor table locked (${ms} ms)"; else echo "  bad: outcome changed: [$fa] vs [$fb]"; D2FAIL=1; fi
  if [ "$ms" -gt 2500 ]; then echo "  bad: business function slowed by the monitor lock: $ms ms"; D2FAIL=1; fi
done < <(paste -d'#' $TMP/base_free.txt $TMP/base_locked.txt)
if [ $D2FAIL -eq 0 ]; then ok "business cron functions unaffected (identical outcome, not blocked) while the monitoring table is exclusively locked"; else fail "a business function was affected by the monitoring lock"; fi
R=$(q "select public._system_job_observe()")
if echo "$R" | grep -q '"ok" *: *true'; then ok "observer recovers once the lock is released"; else fail "observer did not recover: $R"; fi

echo "D4: the observer writes only to system_job_state"
SNAP="select (select count(*) from cron.job) || '/' || (select count(*) from public.system_issues) || '/' || (select count(*) from public.system_issue_events) || '/' || (select count(*) from public.profiles) || '/' || (select count(*) from public.training_sessions) || '/' || (select count(*) from net.http_request_queue) || '/' || (select md5(string_agg(command || schedule || jobname, ',' order by jobname)) from cron.job where jobname <> 'system-monitor-observe')"
CNT1=$(q "$SNAP")
q "select public._system_job_observe()" >/dev/null
q "select public._system_job_observe()" >/dev/null
CNT2=$(q "$SNAP")
[ -n "$CNT1" ] || fail "snapshot query failed"
expect "cron jobs (and business command/schedule hash), issues, events, profiles, training_sessions, pg_net queue unchanged" "$CNT1" "$CNT2"

echo "D5: natural pg_cron execution (only if the scheduler is running here)"
JOB=$(q "select jobid from cron.job where jobname='system-monitor-observe'")
if [ -z "$JOB" ]; then fail "observer cron job missing"; else
  W=0
  while [ $W -lt 8 ]; do
    N=$(q "select count(*) from cron.job_run_details where jobid=$JOB and status='succeeded'")
    [ "${N:-0}" -ge 1 ] && break
    sleep 40; W=$((W+1))
  done
  N=$(q "select count(*) from cron.job_run_details where jobid=$JOB and status='succeeded'")
  if [ "${N:-0}" -ge 1 ]; then
    ok "pg_cron ran the observer ($N succeeded run(s))"
    OBS=$(q "select (last_observed_at is not null)::text || ' ' || (last_result ->> 'ok') from public.system_job_state where job_key='system-monitor-observe'")
    expect "heartbeat written" "true true" "$OBS"
    echo "  info: failed observer runs in this window: $(q "select count(*) from cron.job_run_details where jobid=$JOB and status='failed'")"
  else
    echo "  SKIPPED: no natural run within the wait window (the scheduler may not be running in this local stack)"
  fi
fi

rm -rf $TMP
echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
