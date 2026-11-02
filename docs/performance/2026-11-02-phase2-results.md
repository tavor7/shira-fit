# Performance Phase 2 — results and release readiness (2026-11-02)

Findings and priorities: [2026-10-31-phase2-audit.md](2026-10-31-phase2-audit.md). Branch `perf/phase2-app-wide`
(from `origin/main` 3bb5001). Labels: **[M-local]** isolated perf stack, +190 ms modelled latency per request, no
bandwidth limit (so payload savings appear as KB, not ms) · **[M-prod]** production, read-only.

## Method

Builds A (`origin/main` + inert instrumentation, 418a9cc) and C (all changes) served side by side, Chromium, phone
viewport, same database, alternating A/C rounds. A's first round overlapped with database experiments of mine (an
`ALTER POLICY` lock) and was discarded; compared: A rounds 2+3 vs C rounds 1+2 (4 runs per role per scenario). The
policy migration (P4-1) was **not** applied during these runs; its effect is measured separately at database level.

## Before / after

| Workflow | Before (A) | After (C) | Change | Method |
|---|---|---|---|---|
| Attendance tap on Session Detail (manager, 2 homes stacked) | 60 requests | 26 requests | −57% | attendance.mjs, 4/4 runs identical [M-local] |
| Realtime registration while manager home open | 34 requests / 5 s | 18 | −47% | run-scenarios S7 [M-local] |
| Staff home cold start | 120 KB, 23 req before content | 50 KB, 20 | −58% KB | run-scenarios [M-local] |
| Staff home cold start, content (manager / coach) | 1,272 / 1,284 ms | 1,130 / 1,097 ms | −11% / −15% | run-scenarios [M-local] |
| Back to staff home | 116 KB | 47 KB | −59% | run-scenarios [M-local] |
| Session Detail open (staff) | 35-36 KB | 4-5 KB | −86-89% | run-scenarios [M-local] |
| Roster calendar (menu → content) | 1,600 ms, 13 req, 100 KB | 1,090 ms, 11 req, 30 KB | −32% time | run-screens [M-local] |
| Subscriptions list / detail / dashboard | 7 / 10 / 8 req | 5 / 7 / 5 req | −2-3 req each; time unchanged (≈320 / 490 / 830 ms) | run-screens [M-local] |
| Resume after 35 s in background (all roles) | 9 requests | 6 | −33% | run-scenarios S12 [M-local] |
| Start-up `get_required_consents` | 3 | 1 | −2 | run-scenarios [M-local] |
| Athlete calendar query (DB) | 34.5 ms (prod: 82 ms) | 3.9 ms | −89% | rolled-back experiment [M-local]; prod EXPLAIN ANALYZE [M-prod]; production gain [E] |
| Register / cancel: screen settled after success | animation + 2 sequential round trips | animation only | ≈ −2 RTT (≈0.4 s) [E] | code path; not harness-measured |
| Web cold start | bundle revalidated (304, ≈0.3 s) | served from cache | ≈ −1 RTT [E] | curl on production; needs deploy to measure |
| Athlete home / detail / My Sessions | — | — | unchanged (within noise) | run-scenarios, run-screens [M-local] |
| App startup shell | 3 req, depth 2 | 3 req, depth 2 | unchanged | run-scenarios [M-local] |

Known trade-off: staff Session Detail's previous/next bar now sends 3 tiny queries instead of one full-history query,
so "requests before content" shows +2 for coaches (tap→content 272 → 298 ms, within run-to-run noise; payload 35 → 4 KB).

Scaling: staff calendar requests now grow with future + visible weeks, not with history (production adds ~35 sessions a
week). The per-row price requests are now one per roster load regardless of roster size.

## Functional regression evidence

- **compare-ui** (every visible text and accessibility label, A vs C): home screens for 3 athletes (this / next week,
  My Sessions), coach, manager, super user; Session Detail for athlete (registered / not open / open / waitlisted),
  coach, manager, walk-ins only, super user — **19 identical**. The 20th (super-user home) differs because A **misses**
  a "Hidden" marker that the database confirms (pre-existing bug: ~31 KB `in.()` URL fails silently; fixed by the
  bounded range).
- **Jest** 828 passed (main: 810; +18 new: shareConcurrent, batch prices, staff calendar range), 8 skipped (same
  pre-existing suite as main). **tsc** clean. **Lint** 0 errors, 397 warnings (main 393; +4 React-compiler advisories in
  the same patterns as the surrounding code).
- **SQL 201** batch prices: 3,155 roster rows identical to `session_billing_price_ils`; invoker / stable /
  authenticated-only. **SQL 202** policy: 164 callers (every athlete, coach, manager profile + a no-profile caller) see
  byte-identical `training_sessions` rows and own-registration joins under the old and new policy; InitPlan confirmed;
  migration + rollback round trip restores the exact original fingerprint.
- Keyset previous/next verified against the old algorithm for all 846 sessions as manager and coach: identical except
  same-date-and-time ties (previously arbitrary order, now by id).
- Not covered: real iPhone PWA (same limitation as Phase 1), WebKit runs this phase, Hebrew UI in compare-ui (harness
  runs English; no strings changed).

## Release contents

| Commit | Change | Risk |
|---|---|---|
| 418a9cc, 82c1732, docs commit | instrumentation (inert), harness, docs | none |
| f0e5749 | realtime: hidden manager home skips, hidden Session Detail defers to focus | low |
| 0036465 | nav menu status once per navigation | low |
| 10cc4d2 | same-task sharing of consent / address reads | low |
| 8ed16e9 | batch roster prices — **migration 20261101090000 (additive function)** | low; client falls back if missing |
| 4148ad2 | register / cancel fetch during animation | low |
| 125a221 | bounded staff calendar range + roster calendar parallel/keep-content | medium (browse-back loading path) |
| a8e27fd | keyset previous / next | low |
| d9defec | **migration 20261101091000: RLS `sessions_select` init-plan** | security-adjacent; identical visibility (suite 202) |
| 95a2917 | render.yaml immutable cache headers | low; needs blueprint sync check |

Deploy order: migrations first (both independent of the app; the app works with or without them), then the app.
Post-deploy checks: `curl -I` a `/_expo/static/js/web/index-*.js` URL shows `max-age=31536000, immutable`; Supabase
logs show `rpc/session_billing_prices_ils` 200s and no new 4xx/5xx; staff home browse back several weeks.

Remaining bottlenecks: audit §2 (R1 `manager_weekly_stats` is the largest; needs a financial-RPC decision).
