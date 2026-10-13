#!/usr/bin/env bash
# Mutation checks for the Phase 3E.3 client pipeline: each mutation introduces ONE dangerous defect into a source file (restored
# afterwards) and remoteReporting.test.ts (+ the observer tests) MUST fail. Where two layers guard the same property (eligibility mapper AND the
# server-allowlist table; pump AND deliverNext) the mutation removes both, otherwise it would be an equivalent mutant. Run from the mobile/ directory:
#   bash src/lib/remoteReporting/remoteReporting.mutation-checks.sh [name-filter]
set -u
D=src/lib/remoteReporting
FILES="$D/config.ts $D/eligibility.ts $D/allowlist.ts $D/pipeline.ts src/lib/rpcOutcomes/observer.ts"
BAKDIR=$(mktemp -d)
for f in $FILES; do mkdir -p "$BAKDIR/$(dirname $f)"; cp "$f" "$BAKDIR/$f"; done
restore() { for f in $FILES; do cp "$BAKDIR/$f" "$f"; done; }
trap 'restore; rm -rf "$BAKDIR"' EXIT
PASSED=0; FAILED=0
run() { # name file perl-substitution
  if [ -n "${1:-}" ] && [ -n "${ONLY:-}" ] && [[ "$1" != *"$ONLY"* ]]; then return; fi
  restore
  perl -0pi -e "$3" "$2"
  if cmp -s "$BAKDIR/$2" "$2"; then echo "  ERROR: mutation '$1' did not change $2"; FAILED=$((FAILED+1)); return; fi
  out=$(perl -e 'alarm 250; exec @ARGV' npx jest src/lib/remoteReporting src/lib/rpcOutcomes 2>&1)
  if echo "$out" | grep -qE "Tests:.* [0-9]+ failed"; then echo "  PASSED: '$1' detected ($(echo "$out" | grep -E 'Tests:' | head -1))"; PASSED=$((PASSED+1));
  else echo "  FAILED: '$1' was NOT detected"; FAILED=$((FAILED+1)); fi
  restore
}
ONLY="${1:-}"
run "build gate switched on" $D/config.ts 's/REMOTE_TECHNICAL_REPORTING_ENABLED: boolean = false;/REMOTE_TECHNICAL_REPORTING_ENABLED: boolean = true;/'
run "pipeline ignores its enabled switch" $D/pipeline.ts 's/if \(!this\.enabled\(\)\) return;//g'
run "non-technical outcomes become eligible" $D/eligibility.ts 's/if \(c\.cls !== "technical"\) return null;//'
run "server allowlist bypassed" $D/allowlist.ts 's/return KEYS\.has\(`[^`]*`\);/return true;/'
run "every 5xx transport status approved" $D/eligibility.ts 's/if \(!infra && s !== 500\) return null;/if (s < 500) return null;/; s/if \(!isAllowlisted\(op, "HttpError", code\)\) return null;//'
run "429 approved as transport failure" $D/eligibility.ts 's/const infra = s === 502 \|\| s === 503 \|\| s === 504;/const infra = s === 502 || s === 503 || s === 504 || s === 429;/; s/if \(!isAllowlisted\(op, "HttpError", code\)\) return null;//'
run "PostgREST errors carry the RPC name as the server operation" $D/eligibility.ts 's/operation: "rpc\/postgrest",\n      error_class/operation: `rpc\/${c.operation}`,\n      error_class/'
run "no coalescing" $D/pipeline.ts 's/coalesceMs: 30 \* 60_000,/coalesceMs: 0,/'
run "no pending cap" $D/pipeline.ts 's/this\.pending\.length >= this\.limits\.maxPending/false/'
run "no per-window cap" $D/pipeline.ts 's/tenMin >= this\.limits\.perTenMinutes \|\| this\.admittedAt\.length >= this\.limits\.perHour/false/'
run "reports admitted without a session" $D/pipeline.ts 's/if \(!this\.signedIn\) \{\n      this\.stats\.notSignedIn\+\+;/if (false) {\n      this.stats.notSignedIn++;/'
run "disabled-server verdict does not pause" $D/pipeline.ts 's/this\.pending = \[\];\n        this\.pause\(SIX_HOURS\);/this.pending = [];/'
run "sign-out keeps pending reports" $D/pipeline.ts 's/this\.pending = \[\];\n        if \(was\) this\.epoch\+\+;/if (was) this.epoch++;/'
run "stale in-flight verdict applied after sign-out" $D/pipeline.ts 's/if \(epoch === this\.epoch\) this\.handle\(payload, outcome\);/this.handle(payload, outcome);/'
run "unexpected field added to the payload" $D/pipeline.ts 's/if \(b\.appVersion\) payload\.app_version = b\.appVersion;/if (b.appVersion) payload.app_version = b.appVersion;\n    (payload as unknown as Record<string, unknown>).user_id = "u";/'
run "message derived from the failure" $D/eligibility.ts 's/message: FIXED_MESSAGES\[klass\],/message: code,/'
run "production observer retains an aggregate" src/lib/rpcOutcomes/observer.ts 's/if \(!this\.aggregate\(\)\) return;//'
run "request retries are unbounded (failures never pause)" $D/pipeline.ts 's/this\.failures\+\+;/this.failures = 0;/'
run "multiple in-flight deliveries" $D/pipeline.ts 's/if \(this\.inFlight \|\| this\.pending\.length === 0 \|\| !this\.signedIn \|\| !this\.deliverer\) return;\n    if \(this\.now\(\) < this\.pausedUntil\) return;/if (this.pending.length === 0 || !this.deliverer) return;/; s/if \(this\.inFlight \|\| !this\.signedIn \|\| !this\.deliverer \|\| this\.pending\.length === 0\) return;/if (!this.deliverer || this.pending.length === 0) return;/'
echo "RESULT: $PASSED detected, $FAILED not detected"
[ $FAILED -eq 0 ]
