#!/usr/bin/env bash
# Harness self-test for 151_waitlist_cancel_migration_no_backfill.sh (Phase 4B).
# Suite 151 used to pipe its output through `grep ... || ...`, so a FAILED/ERROR line counted as a match and the script exited 0 even when an
# assertion had failed. This script proves the fixed harness (same approach as 157b):
#   P  positive path         : the real suite exits 0 and prints its PASSED line;
#   N1 negative path         : a deliberately failing assertion (T151_FORCE_FAIL=1, raised inside the suite's own rolled-back transaction)
#                              makes the suite exit NON-ZERO and print the failure line;
#   N2 broken database call  : an unusable PSQL command makes the suite exit non-zero;
#   N3 psql fails, exit 3    : a stub psql that prints an assertion failure and exits 3 (the exact masked scenario) -> non-zero;
#   N4 psql exits 0 + ERROR  : a stub psql that prints an ERROR line but exits 0 -> non-zero (output is checked too);
#   N5 psql exits 0, silent  : a stub psql that prints nothing (no PASSED line) -> non-zero.
# N2-N5 need no database. Nothing is modified: the forced failure happens inside the suite's transaction, which always ends in ROLLBACK.
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" supabase/tests/151b_waitlist_cancel_harness_selftest.sh
set -u
PSQL=${PSQL:?set PSQL}
HERE="$(cd "$(dirname "$0")" && pwd)"; SUITE="$HERE/151_waitlist_cancel_migration_no_backfill.sh"
FAILED=0; PASSED=0
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
stub() { printf '#!/usr/bin/env bash\ncat > /dev/null\n%s\n' "$2" > "$TMPD/$1"; chmod +x "$TMPD/$1"; echo "$TMPD/$1"; }

OUT=$(PSQL="$PSQL" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok "P: the real suite exits 0 (rc=$RC)" || fail "P: the real suite should exit 0, got $RC: $(printf '%s' "$OUT" | tail -2)"
printf '%s' "$OUT" | grep -q "NO-BACKFILL PASSED" && ok "P: the PASSED result line is printed" || fail "P: PASSED line missing"

OUT=$(T151_FORCE_FAIL=1 PSQL="$PSQL" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N1: a deliberately failed assertion makes the suite exit non-zero (rc=$RC)" || fail "N1: a failed assertion exited 0 - the harness still hides failures"
printf '%s' "$OUT" | grep -q "forced failure (harness self-test)" && ok "N1: the failure message is shown" || fail "N1: failure message missing"
printf '%s' "$OUT" | grep -q "^FAILED: psql exited with status" && ok "N1: the harness itself reports FAILED" || fail "N1: harness FAILED line missing"

OUT=$(PSQL="false" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N2: an unusable psql command makes the suite exit non-zero (rc=$RC)" || fail "N2: a broken database call exited 0"

S=$(stub s3 'echo "psql:<stdin>:1: ERROR:  NO-BACKFILL FAILED: simulated assertion failure"; exit 3')
OUT=$(PSQL="$S" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N3: psql reporting a failed assertion and exiting 3 -> non-zero (rc=$RC)" || fail "N3: exit 0 although psql failed (the original masking bug)"

S=$(stub s4 'echo "psql:<stdin>:1: ERROR:  something went wrong"; exit 0')
OUT=$(PSQL="$S" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N4: an ERROR line with exit status 0 -> non-zero (rc=$RC)" || fail "N4: ERROR line accepted"

S=$(stub s5 'exit 0')
OUT=$(PSQL="$S" bash "$SUITE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "N5: no PASSED line (silent psql) -> non-zero (rc=$RC)" || fail "N5: a run without a PASSED line was accepted"

echo "151b harness self-test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
