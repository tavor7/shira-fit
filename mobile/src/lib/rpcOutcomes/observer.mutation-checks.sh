#!/usr/bin/env bash
# Mutation checks for the Phase 3C/3D observer: each mutation introduces ONE dangerous defect into observer.ts or postgrestErrors.ts
# (restored afterwards) and the observer tests (rpcOutcomeObserver.test.ts + postgrestOutcomes.test.ts) MUST fail.
# Run from the mobile/ directory:  bash src/lib/rpcOutcomes/observer.mutation-checks.sh
set -u
F=src/lib/rpcOutcomes/observer.ts
G=src/lib/rpcOutcomes/postgrestErrors.ts
BAK=$(mktemp); BAKG=$(mktemp)
cp "$F" "$BAK"; cp "$G" "$BAKG"
trap 'cp "$BAK" "$F"; cp "$BAKG" "$G"; rm -f "$BAK" "$BAKG"' EXIT
PASSED=0; FAILED=0
runf() { # name  file  backup  perl-substitution
  cp "$BAK" "$F"; cp "$BAKG" "$G"
  perl -0pi -e "$4" "$2"
  if cmp -s "$3" "$2"; then echo "  ERROR: mutation '$1' did not change $2"; FAILED=$((FAILED+1)); return; fi
  out=$(perl -e 'alarm 250; exec @ARGV' npx jest src/lib/rpcOutcomes/rpcOutcomeObserver src/lib/rpcOutcomes/postgrestOutcomes 2>&1)
  if echo "$out" | grep -qE "Tests:.* [0-9]+ failed"; then echo "  PASSED: '$1' detected ($(echo "$out" | grep -E 'Tests:' | head -1))"; PASSED=$((PASSED+1));
  else echo "  FAILED: '$1' was NOT detected"; FAILED=$((FAILED+1)); fi
  cp "$BAK" "$F"; cp "$BAKG" "$G"
}
run() { runf "$1" "$F" "$BAK" "$2"; }       # mutate observer.ts
runp() { runf "$1" "$G" "$BAKG" "$2"; }     # mutate postgrestErrors.ts
run "unknown treated as technical (future-reportable)" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "unknown",/'
run "business treated as future-reportable" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "business",/'
run "uncertain treated as future-reportable" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "uncertain",/'
run "operation ignored when classifying" 's/classifyRpcOutcome\(op, code\)/classifyRpcOutcome("any_operation", code)/'
run "result mutated by the observer" 's/const r = result as \{ data\?: unknown; error\?: unknown; status\?: unknown \};/const r = result as { data?: unknown; error?: unknown; status?: unknown }; (r as { data?: unknown }).data = undefined;/'
run "observer exception reaches the caller (observe)" 's/\} catch \{\n      \/\* observation must never affect the caller \*\//} catch (e) {\n      throw e;/'
run "observer exception reaches the caller (forward)" 's/              \} catch \{\n                \/\* an observer fault must never reach the caller \*\/\n              \}/              } catch (e) {\n                throw e;\n              }/'
run "full result retained" 's/count: 1,\n        firstAt: t,/count: 1, raw: c,\n        firstAt: t,/'
run "raw error text retained (no code sanitization)" 's/code = CODE_RE\.test\(rawCode\) \? rawCode : NON_CODE;/code = rawCode;/'
run "arguments retained via the operation name" 's/observer\.observe\(fn, value\);/observer.observe(String(fn) + JSON.stringify(args), value);/; s/typeof operation === "string" \&\& OP_RE\.test\(operation\) \? operation : OTHER_OP/typeof operation === "string" ? operation : OTHER_OP/'
run "unbounded observation growth" 's/this\.map\.size < this\.maxKeys/true/'
run "Phase 3B reporter called for technical outcomes" 's/import \{ classifyRpcOutcome \} from "\.\/classify";/import { classifyRpcOutcome } from ".\/classify";\nimport { reportTechnicalError } from "..\/techReporting\/reporter";/; s/(    this\.totals\[malformed)/    if (c.class === "technical") reportTechnicalError({ operation: "rpc\/" + op, errorCode: code });\n$1/'
run "delivery hook installed" 's/import \{ classifyRpcOutcome \} from "\.\/classify";/import { classifyRpcOutcome } from ".\/classify";\nimport { technicalReporter } from "..\/techReporting\/reporter";/; s/(    const c = client as \{ rpc\?: unknown;)/    technicalReporter.setDeliverer(() => undefined);\n$1/'
run "ingestion RPC called" 's/(    const key = `\$\{channel\}\|\$\{op\}\|\$\{code\}`;)/    void (globalThis as { supabase?: { rpc: (n: string) => unknown } }).supabase?.rpc("report_client_error");\n$1/'
run "transport-owned errors (5xx, 408, 429, network) observed too (duplicate ownership)" 's/if \(!ownsHttpStatus\(r\.status\)\) \{/if (false) {/'
run "an alternative reason shape is observed for ANY operation (field-name heuristic)" 's/Object\.prototype\.hasOwnProperty\.call\(REVIEWED_REASON_SHAPES, op\) \? REVIEWED_REASON_SHAPES\[op\] : undefined/REVIEWED_REASON_SHAPES.manager_activity_revert_info/'
run "reason observed even when the reviewed flag says success" 's/ \|\| dd\[shape\.flagKey\] !== shape\.flagValue//'
run "partial failure counts classified (failed > 0 treated as an outcome)" 's/if \(d\.ok === false\) \{/if (d.ok === false || (d as { failed?: number }).failed) {/'
runp "every P0001 raise treated as technical" 's/return \{ \.\.\.classifyRpcOutcome\(operation, token\), raised: true \};/return { ...classifyRpcOutcome(operation, token), class: "technical", raised: true };/'
runp "raw P0001 message retained as the code" 's/typeof rawMessage === "string" \&\& RAISE_TOKEN_RE\.test\(rawMessage\) \? rawMessage : NON_CODE/typeof rawMessage === "string" ? rawMessage : NON_CODE/'
runp "429 owned by the RPC observer as well as by transport" 's/ \&\& status !== 429//'
runp "5xx owned by the RPC observer as well as by transport" 's/status >= 400 \&\& status < 500 \&\&/status >= 400 \&\& status < 600 \&\&/'
runp "21000 no longer technical" 's/"21000": \[T,/"21000": [U,/'
runp "unknown codes become technical" 's/return unknown\(rawCode\);/return { operation, code: rawCode, class: "technical", source: "structured_code", raised: false };/'
runp "forbidden-style 4xx (42501) treated as technical" 's/"42501": \[U,/"42501": [T,/'
runp "constraint violations (class 23) treated as technical" 's/"23": \[U,/"23": [T,/'
echo "RESULT: $PASSED detected, $FAILED not detected"
[ $FAILED -eq 0 ]
