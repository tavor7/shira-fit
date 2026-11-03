#!/usr/bin/env bash
# Runs every subscription database suite against a DISPOSABLE Supabase database and exits non-zero if
# any fails. Used by .github/workflows/subscription-db-tests.yml and by hand.
#
#   DB_CONTAINER=<db container> scripts/db-tests/run-subscription-suite.sh [suite-name-filter]
#
# Never point this at production: the suites commit fixture users, sessions and subscriptions.
set -u
DB_CONTAINER=${DB_CONTAINER:?set DB_CONTAINER to a disposable Supabase db container}
FILTER=${1:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

export PSQL="docker exec -i $DB_CONTAINER psql -U postgres"
export PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i $DB_CONTAINER psql -h 127.0.0.1 -U authenticator -d postgres"

SUITES=(
  159_subscription_billing_integrity_tests.sh
  161_subscription_internals_execute_privileges_tests.sh
  167_subscription_terms_consent_tests.sh
  168_athlete_next_week_usage_tests.sh
  169_subscription_group_price_defaults_tests.sh
  170_subscription_duration_presets_billing_tests.sh
  171_subscription_terms_management_tests.sh
  172_subscription_terms_discard_draft_tests.sh
  182_subscription_hard_delete_guard_tests.sh
  187_subscription_payments_tests.sh
  189_subscription_delete_payment_guard_tests.sh
  190_subscription_edit_no_op_vs_real_change_tests.sh
  191_session_delete_subscription_coverage_cascade_tests.sh
  192_subscription_future_registrations_tests.sh
  193_subscription_weekly_usage_tests.sh
  197_subscription_overview_period_reversal_tests.sh
  198_subscription_reconcile_live_set_tests.sh
  199_record_subscription_payment_date_eligibility_tests.sh
  200_session_subscription_coverage_and_start_date_correction_tests.sh
  211_manager_reverse_account_payment_tests.sh
  212_admin_reverse_account_payment_tests.sh
)
# Remediation suites, added with the fixes they protect.
for f in supabase/tests/2[23][0-9]_subscription_*.sh; do [ -e "$f" ] && SUITES+=("$(basename "$f")"); done

failed=(); passed=0
for s in "${SUITES[@]}"; do
  case "$s" in *"$FILTER"*) ;; *) continue ;; esac
  log=$(mktemp)
  if bash "supabase/tests/$s" >"$log" 2>&1; then
    passed=$((passed+1)); echo "ok    $s ($(grep -c 'PASSED' "$log") checks)"
  else
    failed+=("$s"); echo "FAIL  $s"; grep -E 'FAILED|ABORTED|ERROR' "$log" | head -15 | cut -c1-220 | sed 's/^/      /'
  fi
  rm -f "$log"
done
echo "suites passed: $passed, failed: ${#failed[@]}"
[ ${#failed[@]} -eq 0 ]
