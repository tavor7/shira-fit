#!/usr/bin/env bash
# System monitoring Phase 1: REAL concurrency tests (separate database connections, committed data).
#
# Every worker is its own psql process = its own session/transaction. Workers start together: they block
# on a shared advisory lock that a coordinator session holds exclusively, then are released at once.
#
#   C1  concurrent FIRST creation of the same fingerprint (exactly one issue, exactly one `created`)
#   C2  concurrent repeats (exact occurrence counter, bounded events)
#   C3  resolve vs occurrence (a new occurrence is never buried)
#   C4  mute vs occurrence
#   C5  maintenance (auto-quiet) vs recurrence
#   C6  pruning (retention delete) vs ingestion
#   C7  per-user quota race (exactly the quota is accepted)
#   C8  bucket / event sampling race (hourly cap respected)
#   C9  lock contention (a blocked report is dropped within ~lock_timeout; nothing half-written)
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/141_system_monitoring_concurrency.sh
# (any command that runs `psql` against a database with the 3 monitoring migrations applied; the script
# creates and removes its own committed fixtures and restores client_ingest_enabled = false).
set -u
PSQL=${PSQL:?set PSQL to a psql command line, e.g. "psql -U postgres -h 127.0.0.1 -p 54322 postgres"}
TMP=$(mktemp -d)
LOCKKEY=7141001
FAILED=0
PASSED=0

q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "$1"; }

ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi
}
expect_le() { if [ "$3" -le "$2" ] 2>/dev/null; then ok "$1 ($3 <= $2)"; else fail "$1: $3 is not <= $2"; fi; }

MGR=$(uuidgen | tr 'A-Z' 'a-z')
USR=$(uuidgen | tr 'A-Z' 'a-z')
CLAIMS_MGR="{\"sub\":\"$MGR\",\"role\":\"authenticated\"}"
CLAIMS_USR="{\"sub\":\"$USR\",\"role\":\"authenticated\"}"

cleanup() {
  q "delete from public.system_issues where operation like 'conc/%' or operation like 'rpc/c7%';" >/dev/null 2>&1
  q "delete from public.system_report_quota;" >/dev/null 2>&1
  q "update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';" >/dev/null 2>&1
  q "delete from auth.users where id in ('$MGR','$USR');" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- fixtures (committed) ----
q "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
   ('$MGR','00000000-0000-0000-0000-000000000000','authenticated','authenticated','c141-mgr@test.local','{\"full_name\":\"m\",\"phone\":\"0501410001\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\"}',now(),now()),
   ('$USR','00000000-0000-0000-0000-000000000000','authenticated','authenticated','c141-usr@test.local','{\"full_name\":\"u\",\"phone\":\"0501410002\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\"}',now(),now());
   update public.profiles set role='manager', approval_status='approved' where user_id='$MGR';
   update public.profiles set approval_status='approved' where user_id='$USR';" >/dev/null || { echo "fixture setup failed"; exit 2; }
q "delete from public.system_issues where operation like 'conc/%'; delete from public.system_report_quota;" >/dev/null

# Start N workers that all wait on the barrier, run SQL $2 (stdin), then are released together.
# Output of worker i goes to $TMP/w_<tag>_<i>.out ; stderr to $TMP/w_<tag>_<i>.err
race() { # tag n sql
  local tag=$1 n=$2 sql=$3 i
  ( $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(2.5); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1 ) &
  local coord=$!
  sleep 0.7
  local pids=()
  for i in $(seq 1 "$n"); do
    ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\n%s\n" "$LOCKKEY" "$LOCKKEY" "$sql" | $PSQL -qAt >"$TMP/w_${tag}_$i.out" 2>"$TMP/w_${tag}_$i.err" ) &
    pids+=($!)
  done
  wait "${pids[@]}" "$coord" 2>/dev/null
}
errs() { cat "$TMP"/w_$1_*.err 2>/dev/null | grep -ci "error" ; }
issue_of() { q "select $2 from public.system_issues where operation = '$1';"; }

J() { awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%40)/1000}'; }

PAYLOAD() { # operation message
  printf '{"source":"edge","subsystem":"concurrency","operation":"%s","message":"%s","severity":"error"}' "$1" "$2"
}

echo "== C1: concurrent first creation of one fingerprint (12 sessions)"
P=$(PAYLOAD conc/c1 "first-creation race")
race c1 12 "select public._system_ingest('trusted', '$P'::jsonb, null);"
expect "C1 one issue" 1 "$(q "select count(*) from public.system_issues where operation='conc/c1'")"
expect "C1 occurrence_count" 12 "$(issue_of conc/c1 occurrence_count)"
expect "C1 exactly one creator" 1 "$(cat "$TMP"/w_c1_*.out | grep -c '"created": true')"
expect "C1 bucket count" 12 "$(q "select b.count from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c1'")"
expect "C1 one create transition" 1 "$(q "select count(*) from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.operation='conc/c1' and t.kind='create'")"
expect_le "C1 events <= 5" 5 "$(q "select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.operation='conc/c1'")"
expect "C1 first event present" 1 "$(q "select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.operation='conc/c1' and e.sample_reason='first'")"
expect "C1 no errors surfaced" 0 "$(errs c1)"

echo "== C2: concurrent repeats (12 sessions x 40 reports on an existing issue)"
P=$(PAYLOAD conc/c2 "repeat race")
q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
race c2 12 "select public._system_ingest('trusted', '$P'::jsonb, null) from generate_series(1,40);"
expect "C2 occurrence_count" 481 "$(issue_of conc/c2 occurrence_count)"
expect "C2 bucket count" 481 "$(q "select b.count from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c2'")"
expect_le "C2 events <= 5 (hourly cap)" 5 "$(q "select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.operation='conc/c2'")"
expect "C2 no errors surfaced" 0 "$(errs c2)"

echo "== C3: resolve vs occurrence (20 iterations)"
A_OK=0; A_STALE=0; BAD=0
for it in $(seq 1 20); do
  OP="conc/c3_$it"; P=$(PAYLOAD "$OP" "resolve race")
  q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
  LS=$(q "select last_seen from public.system_issues where operation='$OP'")
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect set_config('request.jwt.claims','%s',false);\nselect public.system_issue_resolve((select id from public.system_issues where operation='%s'), 'manual_fixed', '%s'::timestamptz);\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$CLAIMS_MGR" "$OP" "$LS" > "$TMP/c3a.sql" )
  ( $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(1.2); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1 ) & CO=$!
  sleep 0.5
  ( $PSQL -qAt < "$TMP/c3a.sql" > "$TMP/c3a.out" 2>"$TMP/c3a.err" ) & PA=$!
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_ingest('trusted', '%s'::jsonb, null);\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$P" | $PSQL -qAt > "$TMP/c3b.out" 2>"$TMP/c3b.err" ) & PB=$!
  wait $PA $PB $CO 2>/dev/null
  ST=$(issue_of "$OP" status); OC=$(issue_of "$OP" occurrence_count); RC=$(issue_of "$OP" reopen_count)
  LAST=$(q "select t.to_status from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.operation='$OP' order by t.id desc limit 1")
  if grep -q '"ok" *: *true' "$TMP/c3a.out"; then A_OK=$((A_OK+1)); fi
  if grep -q 'stale' "$TMP/c3a.out"; then A_STALE=$((A_STALE+1)); fi
  if [ "$ST" != "open" ] || [ "$OC" != "2" ] || [ "$LAST" != "$ST" ]; then BAD=$((BAD+1)); echo "    iteration $it: status=$ST occ=$OC reopen=$RC last_transition=$LAST"; fi
done
expect "C3 iterations with a lost/buried occurrence or inconsistent state" 0 "$BAD"
echo "    interleavings seen: resolve-won=$A_OK stale-refused=$A_STALE"

echo "== C3b: deterministic order - the occurrence commits FIRST while the manager's resolve is in flight"
OP="conc/c3b"; P=$(PAYLOAD "$OP" "resolve vs occurrence, occurrence first")
q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
LS=$(q "select last_seen from public.system_issues where operation='$OP'")
( printf "begin;\nselect public._system_ingest('trusted', '%s'::jsonb, null);\nselect pg_sleep(1.5);\ncommit;\n" "$P" | $PSQL -qAt >"$TMP/c3b_rep.out" 2>"$TMP/c3b_rep.err" ) & PB=$!
sleep 0.5
printf "select set_config('request.jwt.claims','%s',false);\nselect public.system_issue_resolve((select id from public.system_issues where operation='%s'), 'manual_fixed', '%s'::timestamptz);\n" "$CLAIMS_MGR" "$OP" "$LS" | $PSQL -qAt >"$TMP/c3b_res.out" 2>"$TMP/c3b_res.err"
wait $PB 2>/dev/null
case "$(cat "$TMP/c3b_res.out")" in *stale*) ok "C3b resolve refused as stale (the newer occurrence was not buried)";; *) fail "C3b resolve result: $(cat "$TMP/c3b_res.out")";; esac
expect "C3b status stays open" open "$(issue_of "$OP" status)"
expect "C3b occurrence counted" 2 "$(issue_of "$OP" occurrence_count)"
expect "C3b not reopened (it was never resolved)" 0 "$(issue_of "$OP" reopen_count)"

echo "== C4: mute vs occurrence (20 iterations)"
BAD=0
for it in $(seq 1 20); do
  OP="conc/c4_$it"; P=$(PAYLOAD "$OP" "mute race")
  q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
  ( $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(1.2); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1 ) & CO=$!
  sleep 0.5
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect set_config('request.jwt.claims','%s',false);\nselect public.system_issue_mute((select id from public.system_issues where operation='%s'));\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$CLAIMS_MGR" "$OP" | $PSQL -qAt > "$TMP/c4a.out" 2>"$TMP/c4a.err" ) & PA=$!
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_ingest('trusted', '%s'::jsonb, null);\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$P" | $PSQL -qAt > "$TMP/c4b.out" 2>"$TMP/c4b.err" ) & PB=$!
  wait $PA $PB $CO 2>/dev/null
  ST=$(issue_of "$OP" status); OC=$(issue_of "$OP" occurrence_count); RC=$(issue_of "$OP" reopen_count)
  if [ "$ST" != "muted" ] || [ "$OC" != "2" ] || [ "$RC" != "0" ]; then BAD=$((BAD+1)); echo "    iteration $it: status=$ST occ=$OC reopen=$RC"; fi
done
expect "C4 iterations ending anything but muted / counted / not reopened" 0 "$BAD"

echo "== C5: maintenance (auto-quiet) vs recurrence (15 iterations)"
BAD=0; REOPENED=0
for it in $(seq 1 15); do
  OP="conc/c5_$it"; P=$(PAYLOAD "$OP" "maintenance race")
  q "select public._system_ingest('trusted', '$P'::jsonb, null); update public.system_issues set last_seen = now() - interval '10 days' where operation='$OP';" >/dev/null
  ( $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(1.2); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1 ) & CO=$!
  sleep 0.5
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_monitoring_maintenance();\n" "$LOCKKEY" "$LOCKKEY" "$(J)" | $PSQL -qAt > "$TMP/c5a.out" 2>"$TMP/c5a.err" ) & PA=$!
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_ingest('trusted', '%s'::jsonb, null);\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$P" | $PSQL -qAt > "$TMP/c5b.out" 2>"$TMP/c5b.err" ) & PB=$!
  wait $PA $PB $CO 2>/dev/null
  ST=$(issue_of "$OP" status); OC=$(issue_of "$OP" occurrence_count); RC=$(issue_of "$OP" reopen_count)
  KINDS=$(q "select coalesce(string_agg(t.kind, ',' order by t.id),'') from public.system_issue_transitions t join public.system_issues i on i.id=t.issue_id where i.operation='$OP'")
  [ "$RC" = "1" ] && REOPENED=$((REOPENED+1))
  if [ "$ST" != "open" ] || [ "$OC" != "2" ]; then BAD=$((BAD+1)); echo "    iteration $it: status=$ST occ=$OC reopen=$RC kinds=$KINDS"; fi
  if [ "$RC" = "1" ] && [ "$KINDS" != "create,auto_resolve,auto_reopen" ]; then BAD=$((BAD+1)); echo "    iteration $it: bad transition history $KINDS"; fi
  if [ "$RC" = "0" ] && [ "$KINDS" != "create" ]; then BAD=$((BAD+1)); echo "    iteration $it: bad transition history $KINDS"; fi
done
expect "C5 iterations where a recurrence was lost, left resolved or left an inconsistent history" 0 "$BAD"
echo "    interleavings seen: maintenance-resolved-then-reopened=$REOPENED, report-first(no resolve)=$((15-REOPENED))"

echo "== C6: retention delete vs ingestion (15 iterations)"
BAD=0; DELETED=0
for it in $(seq 1 15); do
  OP="conc/c6_$it"; P=$(PAYLOAD "$OP" "prune race")
  q "select public._system_ingest('trusted', '$P'::jsonb, null);
     update public.system_issues set status='resolved', resolution='manual_fixed', resolved_at = now() - interval '3 years', last_seen = now() - interval '3 years' where operation='$OP';" >/dev/null
  ( $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(1.2); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1 ) & CO=$!
  sleep 0.5
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_monitoring_maintenance();\n" "$LOCKKEY" "$LOCKKEY" "$(J)" | $PSQL -qAt > "$TMP/c6a.out" 2>"$TMP/c6a.err" ) & PA=$!
  ( printf "select pg_advisory_lock_shared(%s);\nselect pg_advisory_unlock_shared(%s);\nselect pg_sleep(%s);\nselect public._system_ingest('trusted', '%s'::jsonb, null);\n" "$LOCKKEY" "$LOCKKEY" "$(J)" "$P" | $PSQL -qAt > "$TMP/c6b.out" 2>"$TMP/c6b.err" ) & PB=$!
  wait $PA $PB $CO 2>/dev/null
  N=$(q "select count(*) from public.system_issues where operation='$OP'")
  ST=$(issue_of "$OP" status); OC=$(issue_of "$OP" occurrence_count)
  [ "$OC" = "1" ] && DELETED=$((DELETED+1))
  if [ "$N" != "1" ] || [ "$ST" != "open" ] || { [ "$OC" != "1" ] && [ "$OC" != "2" ]; }; then BAD=$((BAD+1)); echo "    iteration $it: rows=$N status=$ST occ=$OC"; fi
done
expect "C6 iterations where the report vanished or two rows existed" 0 "$BAD"
echo "    interleavings seen: deleted-then-recreated=$DELETED, reopened-before-delete=$((15-DELETED))"

echo "== C7: per-user quota race (6 sessions x 10 reports, quota 20/hour)"
q "update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled'; delete from public.system_report_quota;" >/dev/null
q "select public._system_ingest('trusted', '{\"source\":\"edge\",\"operation\":\"rpc/c7\",\"message\":\"quota race\"}'::jsonb, null);" >/dev/null
# the same fingerprint the client will produce: source=client => build the issue through the client path once as another identity
SQLC="select set_config('request.jwt.claims','$CLAIMS_USR',false);
select public.report_client_error('{\"operation\":\"rpc/c7\",\"message\":\"quota race\"}'::jsonb) from generate_series(1,10);"
race c7 6 "$SQLC"
ACC=$(cat "$TMP"/w_c7_*.out | grep -c '"accepted" *: *true')
expect "C7 accepted reports == quota" 20 "$ACC"
expect "C7 quota row" 20 "$(q "select reports from public.system_report_quota where user_id='$USR'")"
expect "C7 no errors surfaced" 0 "$(errs c7)"
q "update public.system_monitoring_config set value = 'false'::jsonb where key = 'client_ingest_enabled';" >/dev/null

echo "== C8: bucket / event sampling race (20 sessions x 10 reports)"
P=$(PAYLOAD conc/c8 "sampling race")
q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
race c8 20 "select public._system_ingest('trusted', '$P'::jsonb, null) from generate_series(1,10);"
expect "C8 occurrence_count" 201 "$(issue_of conc/c8 occurrence_count)"
expect "C8 bucket count" 201 "$(q "select b.count from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c8'")"
expect_le "C8 sampled counter <= 5" 5 "$(q "select b.sampled from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c8'")"
expect_le "C8 events <= 5" 5 "$(q "select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.operation='conc/c8'")"
expect "C8 events == sampled counter" "$(q "select b.sampled from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c8'")" "$(q "select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.operation='conc/c8'")"

echo "== C9: lock contention (a blocked report is dropped, never waits for the lock, never half-writes)"
P=$(PAYLOAD conc/c9 "lock contention")
q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
BEFORE_OCC=$(issue_of conc/c9 occurrence_count); BEFORE_BKT=$(q "select b.count from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c9'")
( printf "begin;\nselect 1 from public.system_issues where operation='conc/c9' for update;\nselect pg_sleep(4);\ncommit;\n" | $PSQL -qAt >/dev/null 2>&1 ) & HOLDER=$!
sleep 1.0
T0=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')
OUT=$(q "select public._system_ingest('trusted', '$P'::jsonb, null);" 2>"$TMP/c9.err")
T1=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')
ELAPSED=$((T1-T0))
case "$OUT" in *'"reason": "internal"'*) ok "C9 blocked report returned {accepted:false, internal} instead of failing";; *) fail "C9 unexpected result: $OUT";; esac
if [ "$ELAPSED" -lt 3000 ]; then ok "C9 did not wait for the 4s lock (took ${ELAPSED} ms)"; else fail "C9 waited ${ELAPSED} ms for the lock"; fi
expect "C9 no error reached the caller" 0 "$(grep -ci error "$TMP/c9.err")"
wait $HOLDER 2>/dev/null
expect "C9 occurrence_count unchanged (rolled back as a unit)" "$BEFORE_OCC" "$(issue_of conc/c9 occurrence_count)"
expect "C9 bucket unchanged (no half-write)" "$BEFORE_BKT" "$(q "select b.count from public.system_issue_buckets b join public.system_issues i on i.id=b.issue_id where i.operation='conc/c9'")"
q "select public._system_ingest('trusted', '$P'::jsonb, null);" >/dev/null
expect "C9 ingestion works again once the lock is gone" $((BEFORE_OCC+1)) "$(issue_of conc/c9 occurrence_count)"

echo "== global consistency: occurrence_count == sum(bucket counts) for every concurrency issue"
expect "inconsistent issues" 0 "$(q "select count(*) from public.system_issues i where i.operation like 'conc/%' and i.occurrence_count <> (select coalesce(sum(b.count),0) from public.system_issue_buckets b where b.issue_id = i.id)")"
expect "orphan buckets/events/transitions" 0 "$(q "select (select count(*) from public.system_issue_buckets b where not exists (select 1 from public.system_issues i where i.id=b.issue_id)) + (select count(*) from public.system_issue_events e where not exists (select 1 from public.system_issues i where i.id=e.issue_id)) + (select count(*) from public.system_issue_transitions t where not exists (select 1 from public.system_issues i where i.id=t.issue_id))")"

echo
echo "CONCURRENCY RESULT: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
