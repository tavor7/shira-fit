#!/usr/bin/env bash
# Mutation checks for the Phase 3C observer: each mutation introduces ONE dangerous defect into observer.ts (restored afterwards)
# and rpcOutcomeObserver.test.ts MUST fail. Run from the mobile/ directory:  bash src/lib/rpcOutcomes/observer.mutation-checks.sh
set -u
F=src/lib/rpcOutcomes/observer.ts
BAK=$(mktemp)
cp "$F" "$BAK"
trap 'cp "$BAK" "$F"; rm -f "$BAK"' EXIT
PASSED=0; FAILED=0
run() { # name  perl-substitution
  cp "$BAK" "$F"
  perl -0pi -e "$2" "$F"
  if cmp -s "$BAK" "$F"; then echo "  ERROR: mutation '$1' did not change observer.ts"; FAILED=$((FAILED+1)); return; fi
  out=$(perl -e 'alarm 150; exec @ARGV' npx jest src/lib/rpcOutcomes/rpcOutcomeObserver 2>&1)
  if echo "$out" | grep -qE "Tests:.* [0-9]+ failed"; then echo "  PASSED: '$1' detected ($(echo "$out" | grep -E 'Tests:' | head -1))"; PASSED=$((PASSED+1));
  else echo "  FAILED: '$1' was NOT detected"; FAILED=$((FAILED+1)); fi
  cp "$BAK" "$F"
}
run "unknown treated as technical (future-reportable)" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "unknown",/'
run "business treated as future-reportable" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "business",/'
run "uncertain treated as future-reportable" 's/futureReportable: c\.class === "technical",/futureReportable: c.class === "technical" || c.class === "uncertain",/'
run "operation ignored when classifying" 's/classifyRpcOutcome\(op, code\)/classifyRpcOutcome("any_operation", code)/'
run "result mutated by the observer" 's/const r = result as \{ data\?: unknown; error\?: unknown \};/const r = result as { data?: unknown; error?: unknown }; (r as { data?: unknown }).data = undefined;/'
run "observer exception reaches the caller (observe)" 's/\} catch \{\n      \/\* observation must never affect the caller \*\//} catch (e) {\n      throw e;/'
run "observer exception reaches the caller (forward)" 's/              \} catch \{\n                \/\* an observer fault must never reach the caller \*\/\n              \}/              } catch (e) {\n                throw e;\n              }/'
run "full result retained" 's/count: 1,\n          firstAt: t,/count: 1, raw: data,\n          firstAt: t,/'
run "raw error text retained (no code sanitization)" 's/code = CODE_RE\.test\(rawCode\) \? rawCode : NON_CODE;/code = rawCode;/'
run "arguments retained via the operation name" 's/observer\.observe\(fn, value\);/observer.observe(String(fn) + JSON.stringify(args), value);/; s/typeof operation === "string" \&\& OP_RE\.test\(operation\) \? operation : OTHER_OP/typeof operation === "string" ? operation : OTHER_OP/'
run "unbounded observation growth" 's/this\.map\.size < this\.maxKeys/true/'
run "Phase 3B reporter called for technical outcomes" 's/import \{ classifyRpcOutcome \} from "\.\/classify";/import { classifyRpcOutcome } from ".\/classify";\nimport { reportTechnicalError } from "..\/techReporting\/reporter";/; s/(      this\.totals\[malformed)/      if (c.class === "technical") reportTechnicalError({ operation: "rpc\/" + op, errorCode: code });\n$1/'
run "delivery hook installed" 's/import \{ classifyRpcOutcome \} from "\.\/classify";/import { classifyRpcOutcome } from ".\/classify";\nimport { technicalReporter } from "..\/techReporting\/reporter";/; s/(    const c = client as \{ rpc\?: unknown;)/    technicalReporter.setDeliverer(() => undefined);\n$1/'
run "ingestion RPC called" 's/(      const key = `\$\{op\}\|\$\{code\}`;)/      void (globalThis as { supabase?: { rpc: (n: string) => unknown } }).supabase?.rpc("report_client_error");\n$1/'
run "duplicate observation of results that carry an error" 's/if \(r\.error\) return; \/\/ a PostgREST\/transport error result belongs to Phase 3B/\/\/ (error results no longer skipped)/'
echo "RESULT: $PASSED detected, $FAILED not detected"
[ $FAILED -eq 0 ]
