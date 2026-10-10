#!/usr/bin/env bash
# System monitoring Phase 2.4: REAL concurrency tests for the job-issue reporting layer (separate connections, committed data).
#
#   E1  overlapping observers in LIVE mode, persistent stale job: exactly one issue, one occurrence, one create transition
#   E2  overlapping observers on recovery: the issue is resolved exactly once (one auto_resolve transition)
#   E3  recovery racing the engine's own ingestion on one fingerprint: no lost update, transition chain stays consistent,
#       occurrence_count == accepted reports, reopen_count == auto_reopen transitions
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/156_job_issue_reporting_concurrency.sh
# SCRATCH/LOCAL DATABASES ONLY: it temporarily switches the job-monitoring config to live and creates (then deletes) committed
# monitoring rows for one real cron job entry. Never run it against production.
set -u
PSQL=${PSQL:?set PSQL}
TMP=$(mktemp -d)
LOCKKEY=7156001
FAILED=0; PASSED=0
q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "$1"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }

JOB=whatsapp-dispatch-notifications
KEY="job_health:$JOB:stale"
FP="md5('key' || chr(31) || '$KEY')"

# the job must have produced at least one run in this database (a freshly reset local stack needs up to 5 minutes)
W=0
while [ "$(q "select (last_started_at is not null)::text from public.system_job_state where job_key='$JOB'")" != "true" ] && [ $W -lt 40 ]; do sleep 10; W=$((W+1)); done
[ "$(q "select (last_started_at is not null)::text from public.system_job_state where job_key='$JOB'")" = "true" ] || { echo "SKIPPED: $JOB has no observed run yet"; exit 1; }

# --- save, then configure ---
CFG=$(q "select value::text from public.system_monitoring_config where key='job_monitoring'")
ROW=$(q "select stale_after_s from public.system_job_state where job_key='$JOB'")
restore() {
  q "update public.system_monitoring_config set value = '$CFG'::jsonb where key='job_monitoring'" >/dev/null
  q "update public.system_job_state set stale_after_s = $ROW, reporting = '{}'::jsonb, stale = false, shadow = '{}'::jsonb where job_key='$JOB'" >/dev/null
  q "delete from public.system_issues where fingerprint = $FP" >/dev/null
  q "delete from public.system_report_quota" >/dev/null
  rm -rf "$TMP"
}
trap restore EXIT
q "delete from public.system_issues where fingerprint = $FP" >/dev/null
q "update public.system_monitoring_config set value = value || '{\"issue_mode\":\"live\",\"report_enabled\":true,\"shadow\":false,\"issue_refresh_s\":3600}'::jsonb where key='job_monitoring'" >/dev/null
q "update public.system_job_state set stale_after_s = 1, reporting = '{}'::jsonb, grace_until = null where job_key='$JOB'" >/dev/null

round() { # run N observers started together (barrier), wait for all
  for i in 1 2 3 4 5 6; do
    ( $PSQL -qAt -c "select pg_advisory_lock_shared($LOCKKEY); select public._system_job_observe();" > $TMP/r_$i.out 2>$TMP/r_$i.err ) &
  done
  sleep 1
  $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(0.3); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1
  wait
}

echo "E1: overlapping observers, persistent stale job (live)"
round; round; round
ERRS=$(cat $TMP/r_*.err | grep -ci 'error')
expect "no observer errored" 0 "$ERRS"
N=$(q "select count(*) from public.system_issues where fingerprint = $FP")
expect "exactly one issue" 1 "$N"
OCC=$(q "select occurrence_count from public.system_issues where fingerprint = $FP")
expect "exactly one occurrence (no duplicate reports from overlapping observers)" 1 "$OCC"
CRE=$(q "select count(*) from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.fingerprint = $FP and t.kind='create'")
expect "exactly one create transition" 1 "$CRE"
ST=$(q "select status from public.system_issues where fingerprint = $FP")
expect "issue is open" open "$ST"

echo "E2: overlapping observers on recovery"
q "update public.system_job_state set stale_after_s = 7320 where job_key='$JOB'" >/dev/null
round; round; round
RES=$(q "select count(*) from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.fingerprint = $FP and t.kind='auto_resolve'")
expect "resolved exactly once" 1 "$RES"
ST=$(q "select status || '/' || coalesce(resolution,'') from public.system_issues where fingerprint = $FP")
expect "status/resolution" "resolved/auto_recovered" "$ST"

echo "E3: auto-recovery racing ingestion on the same fingerprint"
PAYLOAD="{\"source\":\"cron\",\"subsystem\":\"notifications\",\"operation\":\"cron/$JOB\",\"error_class\":\"JobHealth\",\"error_code\":\"job_stale\",\"message\":\"Scheduled job $JOB has not started within its expected window.\",\"severity\":\"warning\",\"fingerprint_key\":\"$KEY\",\"count\":1}"
ACCEPTED=0
for it in $(seq 1 30); do
  ( $PSQL -qAt -c "select pg_advisory_lock_shared($LOCKKEY); select public._system_ingest('trusted', '$PAYLOAD'::jsonb, null);" > $TMP/i.out 2>$TMP/i.err ) &
  ( $PSQL -qAt -c "select pg_advisory_lock_shared($LOCKKEY); select public._system_issue_auto_recover('$KEY');" > $TMP/a.out 2>$TMP/a.err ) &
  sleep 0.4
  $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(0.15); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1
  wait
  if grep -q '"accepted" *: *true' $TMP/i.out; then ACCEPTED=$((ACCEPTED+1)); fi
done
N=$(q "select count(*) from public.system_issues where fingerprint = $FP")
expect "still exactly one issue" 1 "$N"
CHAIN=$(q "with t as (select t.*, lag(t.to_status) over (order by t.id) prev_to from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.fingerprint = $FP)
           select count(*) from t where (prev_to is not null and from_status is distinct from prev_to) or (prev_to is null and from_status is not null)")
expect "transition chain is consistent (every from_status equals the previous to_status)" 0 "$CHAIN"
REO=$(q "select (i.reopen_count = (select count(*) from public.system_issue_transitions t where t.issue_id=i.id and t.kind='auto_reopen'))::text from public.system_issues i where i.fingerprint = $FP")
expect "reopen_count equals the number of auto_reopen transitions" true "$REO"
LAST=$(q "select (i.status = (select t.to_status from public.system_issue_transitions t where t.issue_id=i.id order by t.id desc limit 1))::text from public.system_issues i where i.fingerprint = $FP")
expect "final status equals the last transition" true "$LAST"
OCC=$(q "select occurrence_count from public.system_issues where fingerprint = $FP")
# the issue already existed (1 occurrence from E1) when E3 started
expect "occurrence_count == 1 + accepted reports (no lost update)" $((1 + ACCEPTED)) "$OCC"
echo "  info: $ACCEPTED of 30 racing ingestions were accepted"

echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
