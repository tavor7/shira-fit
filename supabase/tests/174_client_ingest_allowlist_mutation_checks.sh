#!/usr/bin/env bash
# Mutation checks for monitoring Phase 3E.2: each mutation introduces ONE authorization/integrity defect into the migration
# 20261015100000_system_monitoring_client_allowlist.sql (applied to the scratch database, original restored afterwards) and
# 173_client_ingest_allowlist_tests.sh MUST fail. SCRATCH/LOCAL DATABASES ONLY.
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/174_client_ingest_allowlist_mutation_checks.sh
set -u
PSQL=${PSQL:?set PSQL}; PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations/20261015100000_system_monitoring_client_allowlist.sql"
TMP=$(mktemp -d); trap '$PSQL -q -v ON_ERROR_STOP=1 -f - < "$MIG" >/dev/null 2>&1; rm -rf "$TMP"' EXIT
PASSED=0; FAILED=0
run() { # name perl-substitution  (optional $ONLY: run only mutations whose name contains it)
  if [ -n "${ONLY:-}" ] && [[ "$1" != *"$ONLY"* ]]; then return; fi
  cp "$MIG" "$TMP/m.sql"
  perl -0pi -e "$2" "$TMP/m.sql"
  if cmp -s "$MIG" "$TMP/m.sql"; then echo "  ERROR: mutation '$1' did not change the migration"; FAILED=$((FAILED+1)); return; fi
  if ! $PSQL -q -v ON_ERROR_STOP=1 -f - < "$TMP/m.sql" >/dev/null 2>"$TMP/err"; then
    echo "  PASSED: '$1' detected (the migration's own self-check/constraint refused it)"; PASSED=$((PASSED+1));
  else
    out=$("$HERE/173_client_ingest_allowlist_tests.sh" 2>&1)
    if echo "$out" | grep -qE "RESULT: [0-9]+ passed, [1-9][0-9]* failed"; then echo "  PASSED: '$1' detected ($(echo "$out" | grep RESULT))"; PASSED=$((PASSED+1));
    else echo "  FAILED: '$1' was NOT detected"; FAILED=$((FAILED+1)); fi
  fi
  $PSQL -q -v ON_ERROR_STOP=1 -f - < "$MIG" >/dev/null 2>&1
  # the seed is ON CONFLICT DO NOTHING, so a row added by the 'business outcome seeded' mutant must be removed explicitly
  $PSQL -qAt -c "delete from public.system_issue_rules where authorizes_client and match_operation='rpc/register_for_session' and match_error_code='full'" >/dev/null 2>&1
}
run "default deny removed (unknown tuples accepted)" 's/and v_rule\.id is null then\n    return jsonb_build_object\(\x27accepted\x27, false, \x27reason\x27, \x27not_allowlisted\x27\)/and false then\n    return jsonb_build_object(\x27accepted\x27, false, \x27reason\x27, \x27not_allowlisted\x27)/'
run "default of client_require_rule flipped to false" 's/_system_flag\(\x27client_require_rule\x27, true\)/_system_flag(\x27client_require_rule\x27, false)/'
run "authorization no longer requires authorizes_client (presentation rules authorize)" 's/where x\.enabled and x\.authorizes_client\n/where x.enabled\n/'
run "authorization uses prefix matching (wildcard rules authorize)" 's/x\.match_operation = v_op\n/starts_with(v_op, replace(x.match_operation, \x27*\x27, \x27\x27))\n/'
run "disabled rules still authorize" 's/where x\.enabled and x\.authorizes_client/where x.authorizes_client/'
run "payload validation disabled" 's/if v_require_rule and not public\._system_client_payload_valid\(p_payload\) then/if false then/'
run "unexpected payload keys allowed" 's/if not \(k = any \(c_keys\)\) then/if false then/'
run "nested context allowed" 's/or jsonb_typeof\(v\) in \(\x27object\x27, \x27array\x27\)/or false/'
run "platform 'server' allowed" 's/\^\(ios\|android\|web\)\$/^(ios|android|web|server)\$/'
run "client message text becomes a fingerprint input" 's/p_trust = \x27client\x27 and v_require_rule then \x27\x27 else/p_trust = \x27client\x27 and false then \x27\x27 else/'
run "trusted fingerprint behaviour changed (message dropped for everyone)" 's/case when p_trust = \x27client\x27 and v_require_rule then \x27\x27 else public\._system_normalize_template\(v_msg_raw\) end/\x27\x27/'
# (honouring the client severity hint is an EQUIVALENT mutant: every authorizing rule is capped at warning by constraint, so the effective
#  severity stays the server's either way; the cap is the control, the ignored hint is defense in depth)
run "client message text is stored" 's/    v_msg_raw := v_rule\.set_title;/    v_msg_raw := v_msg_raw;/'
run "client ingestion switch ignored" 's/if p_trust = \x27client\x27 and not public\._system_flag\(\x27client_ingest_enabled\x27, false\) then/if false then/'
run "maintenance auto-resolves client issues" 's/\n      and i\.source <> \x27client\x27[^\n]*//'
run "authorizing rules may carry wildcards" 's/match_operation !~ \x27\[\*\]\x27/true/'
run "authorizing rules may cap at critical" 's/and severity_cap in \(\x27info\x27, \x27warning\x27, \x27error\x27\)/and severity_cap in (\x27info\x27, \x27warning\x27, \x27error\x27, \x27critical\x27)/'
run "a business outcome is seeded into the allowlist" 's/\) as v\(op, cls, code, subsys, title\)/, (\x27rpc\/register_for_session\x27, \x27RpcOutcome\x27, \x27full\x27, \x27rpc\x27, \x27x\x27)\n) as v(op, cls, code, subsys, title)/'
echo "RESULT: $PASSED detected, $FAILED not detected"
[ $FAILED -eq 0 ]
