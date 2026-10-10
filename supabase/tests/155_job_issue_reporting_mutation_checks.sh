#!/usr/bin/env bash
# Mutation checks for Phase 2.4: each mutation re-defines the reporting layer with ONE deliberate defect (applied inside a
# transaction that is always rolled back) and re-runs 154_job_issue_reporting_tests.sql, which MUST fail. Proves the tests
# can actually catch the defects the design is meant to prevent.
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/155_job_issue_reporting_mutation_checks.sh
# Use only against a scratch/local database.
set -u
PSQL=${PSQL:?set PSQL}
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations/20261011100000_job_issue_reporting_dry_run.sql"
TEST="$HERE/154_job_issue_reporting_tests.sql"
FAILED=0; PASSED=0

run_mutation() { # name perl-substitution
  local name="$1" sub="$2"
  local mut
  mut=$(perl -0pe "$sub" "$MIG")
  if [ "$mut" = "$(cat "$MIG")" ]; then echo "  ERROR: mutation '$name' did not change the migration"; FAILED=$((FAILED+1)); return; fi
  local body
  body=$(awk 'BEGIN{b=0} /^begin;$/ && !b {b=1; next} {print}' "$TEST" | sed '$d' | sed '$d')   # drop the test's begin; and its final rollback;
  local out
  out=$( { echo "begin;"; echo "$mut"; echo "$body"; echo "rollback;"; } | $PSQL -v ON_ERROR_STOP=1 -f - 2>&1 )
  if echo "$out" | grep -q "ALL JOB ISSUE REPORTING TESTS PASSED"; then
    echo "  FAILED: mutation '$name' was NOT detected by the tests"; FAILED=$((FAILED+1))
  else
    echo "  PASSED: mutation '$name' detected: $(echo "$out" | grep -m1 -E 'FAILED|ERROR' | cut -c1-150)"; PASSED=$((PASSED+1))
  fi
}

# baseline: the unmutated migration must pass
body=$(awk 'BEGIN{b=0} /^begin;$/ && !b {b=1; next} {print}' "$TEST" | sed '$d' | sed '$d')
out=$( { echo "begin;"; cat "$MIG"; echo "$body"; echo "rollback;"; } | $PSQL -v ON_ERROR_STOP=1 -f - 2>&1 )
echo "$out" | grep -q "ALL JOB ISSUE REPORTING TESTS PASSED" && { echo "  PASSED: baseline (unmutated) passes"; PASSED=$((PASSED+1)); } || { echo "  FAILED: baseline did not pass"; echo "$out" | grep -E "FAILED|ERROR" | head -3; FAILED=$((FAILED+1)); }

run_mutation "unstable fingerprint (timestamp in the key)" 's/select \x27job_health:\x27 \|\| p_job \|\| \x27:\x27 \|\| p_cond;/select \x27job_health:\x27 || p_job || \x27:\x27 || p_cond || \x27:\x27 || floor(extract(epoch from clock_timestamp()))::text;/'
run_mutation "one issue per observer cycle (open state never remembered)" 's/v_open := coalesce\(\(v_c ->> \x27open\x27\)::boolean, false\) and coalesce\(v_c ->> \x27m\x27, \x27\x27\) = p_mode;/v_open := false;/'
run_mutation "resolving one condition resolves another (wrong key on recovery)" 's/_system_issue_auto_recover\(public\._system_job_issue_key\(r\.job_key, v_cond\)\)/_system_issue_auto_recover(public._system_job_issue_key(r.job_key, \x27stale\x27))/'
run_mutation "critical severity allowed (cap 4)" 's/c_cap constant integer := 3;/c_cap constant integer := 4;/'
run_mutation "dry run writes real issues" 's/if p_mode = \x27live\x27 then\n            v_resp := public\._system_ingest/if true then\n            v_resp := public._system_ingest/'
run_mutation "business last_outcome=unknown treated as failure" 's/when \x27failed\x27 then r\.shadow \? \x27would_be_scheduler_failure\x27/when \x27failed\x27 then (r.shadow ? \x27would_be_scheduler_failure\x27 or r.last_outcome = \x27unknown\x27)/'
run_mutation "unregistered jobs are reported" 's/where s\.kind = \x27pg_cron\x27 and s\.registered and s\.monitored and s\.job_key <> c_self\n      and \(s\.paused_until/where s.kind = \x27pg_cron\x27 and s.monitored and s.job_key <> c_self\n      and (s.paused_until/'
run_mutation "reporting failure aborts the observer (step 5b not isolated)" 's/    exception when others then\n      n_errors := n_errors \+ 1;\n      n_issue_err := n_issue_err \+ 1;/    exception when no_data_found then\n      n_errors := n_errors + 1;\n      n_issue_err := n_issue_err + 1;/'
run_mutation "per-job isolation removed (one failing job aborts the pass)" 's/    exception when others then\n      -- this job.s block/    exception when no_data_found then\n      -- this job\x27s block/'
run_mutation "no open confirmation (flapping opens)" 's/v_seen >= v_open_n then v_action := \x27open\x27/true then v_action := \x27open\x27/'
run_mutation "refresh every cycle (occurrence flood)" 's/elsif v_rep is null or p_now - v_rep::timestamptz >= make_interval\(secs => v_refresh\) then/elsif true then/'
run_mutation "resolve on first healthy cycle" 's/if v_ok >= v_res_n then v_action := \x27resolve\x27; end if;/v_action := \x27resolve\x27;/'

echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
