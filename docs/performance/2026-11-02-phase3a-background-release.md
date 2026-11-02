# Phase 3A — Background optimizations: release record (deployed 2026-11-02)

| Item | Value |
|---|---|
| PR | #13 `perf/background-refresh` (clean branch from `main` 8fa0fbf; draft #12 not merged) |
| Commits | e370215 terms re-check throttle · 791d2b3 athlete push re-sync interval (cherry-picks of the reviewed 56bf5fe / 5e26dad) |
| Diff | 5 files, client only: `useSubscriptionTermsGate.ts`, `pushSyncSchedule.ts` (+ test), `(app)/_layout.tsx`, `athlete/sessions.tsx`. No navigation code, no database change |
| CI | `test-and-typecheck` pass (1m59s); locally 831 tests pass, tsc clean, 0 lint errors on the changed files |
| Merge | `52d3001`, 2026-11-02 09:46Z |
| Deploy | Render served bundle `index-dede0faa…` at 09:48:01Z; hashed assets still `immutable` |

## Freshness guarantees kept

- **Terms gate:** login / user change, resume and the 60 s timer always re-check; a navigation re-checks only when the
  last check is ≥ 30 s old → never more than 60 s behind the server (unchanged bound). Accepting terms reloads at once.
  A failed check still never blocks the app; the server still refuses registrations while acceptance is pending.
- **Push re-sync:** login (layout), notification preference / permission changes, activation and onboarding sync
  immediately and unthrottled; the athlete home's safety-net re-sync runs when the last sync is ≥ 10 min old.
  `getUser()` and existing error handling unchanged.

## Functional verification

- Before release [M-local]: visible UI identical in 20/20 scenarios in Chromium and 20/20 in WebKit; navigation journeys
  unchanged; one fewer request on almost every navigation; athlete return to home 15 → 12 requests.
- After release [M-prod, edge logs since 08:32Z]: no 4xx / 5xx from browsers; `get_my_subscription_terms` 30 × 200 (still
  checked); `web_push_subscriptions` 3 × 200 (push registration still syncs); also the Phase 2 batch RPC
  `session_billing_prices_ils` served its first real calls (2 × 200).
- Local main checkout fast-forwarded to 52d3001, clean.
