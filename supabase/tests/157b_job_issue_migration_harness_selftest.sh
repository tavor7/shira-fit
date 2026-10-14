#!/usr/bin/env bash
# Harness self-test for 157_job_issue_migration_no_business_change.sh (Phase 4B.3).
# Suite 157 used to pipe its output through `grep ... || ...`, so a FAILED/ERROR line counted as a match and the script exited 0 even when an
# assertion had failed. This script proves the fixed harness:
#   P  positive path        : the real suite exits 0 and prints its PASSED line;
#   N1 negative path        : a deliberately failing assertion (T157_FORCE_FAIL=1, raised inside the suite's own rolled-back transaction) makes the suite
#                             exit NON-ZERO and print the failure line;
#   N2 broken database call : an unusable PSQL command makes the suite exit non-zero (no false pass when psql cannot run).
# Nothing is modified: the forced failure happens inside the suite's transaction, which always ends in ROLLBACK.
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/157b_job_issue_migration_harness_selftest.sh
set -u
PSQL=${PSQL:?set PSQL}
HERE="$(cd "$(dirname "$0")" && pwd)"; SUITE="$HERE/157_job_issue_migration_no_business_change.sh"
FAILED=0; PASSED=0
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }

OUT=$(PSQL="$PSQL" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok "P: the real suite exits 0 (rc=$RC)" || fail "P: the real suite should exit 0, got $RC: $(printf '%s' "$OUT" | tail -2)"
printf '%s' "$OUT" | grep -q "NO-BUSINESS-CHANGE PASSED" && ok "P: the PASSED result line is printed" || fail "P: PASSED line missing"

OUT=$(T157_FORCE_FAIL=1 PSQL="$PSQL" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N1: a deliberately failed assertion makes the suite exit non-zero (rc=$RC)" || fail "N1: a failed assertion exited 0 — the harness still hides failures"
printf '%s' "$OUT" | grep -q "forced failure (harness self-test)" && ok "N1: the failure message is shown" || fail "N1: failure message missing"
printf '%s' "$OUT" | grep -q "^FAILED: psql exited with status" && ok "N1: the harness itself reports FAILED (the main assertions had already passed; only the forced one failed)" || fail "N1: harness FAILED line missing"

OUT=$(PSQL="false" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N2: an unusable psql command makes the suite exit non-zero (rc=$RC)" || fail "N2: a broken database call exited 0"

echo "157b harness self-test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
