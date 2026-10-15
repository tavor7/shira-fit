# Instrumentation-only deployment — record and verification (2026-10-15)

Approved by you on 2026-10-15. Scope: commit `ad0d693` only. No Phase 1 changes, no database changes.

## Pre-deployment checks

| Check | Result |
|---|---|
| `origin/main` before deploy | `c3967b6` (as expected) |
| Deploy branch content | exactly one commit, `ad0d693`, a fast-forward of `c3967b6` |
| Changed paths | 19 files, all under `mobile/src` or `mobile/app`; no migrations, docs or other paths |
| Your 4 uncommitted migration files | fingerprinted before deploy (SHA-256 + modification time) |
| Default-off / unchanged behaviour | verified on this exact commit: Jest 723 passed, `tsc` clean, lint unchanged, disabled-mode side-by-side 8/8 runs and 72/72 steps identical ([instrumentation-deployment.md](instrumentation-deployment.md) §4) |
| Production bundle before deploy | `index-5356db140f768fb0407d2a8a4ffbe19f.js`, no `sf_perf` (11:39 UTC) |

Note: on 2026-10-14 production served `index-88c68cfb…js`. `origin/main` was unchanged at `c3967b6`, so the 2026-10-15 bundle before deploy is most likely a Render rebuild of the same commit. It is recorded here for completeness.

## Deployment

| | |
|---|---|
| Command | `git push origin perf/instrumentation-deploy:main`, a fast-forward from the branch with no checkout, leaving your working tree untouched |
| Result | `c3967b6..ad0d693  perf/instrumentation-deploy -> main`, pushed 11:39:49 UTC |
| Render | new bundle served at **11:41:00 UTC** (~70 s); `last-modified: Thu, 15 Oct 2026 11:40:59 UTC` |
| **Deployed bundle** | **`/_expo/static/js/web/index-7c236757118d18835bbe934904986f01.js`** (4,123,602 B) |
| Local `main` | moved to `ad0d693` (tracking `origin/main`) |

## Post-deployment verification [M-prod]

**Deployed commit.** The bundle contains every string unique to `ad0d693` (`sf_perf`, `athlete.mySessions`, `session.roster`, `Copy JSON`, `Performance panel`, `__SF_PERF__`). It targets the production Supabase project. Its size is within environment-variable differences of a local build of the same commit.

**Read-only browser checks** (`harness/verify-production.mjs`; no login, no writes; iPhone-sized viewport):

| Check | Chromium | WebKit |
|---|---|---|
| App renders the sign-in screen, no page errors | PASS | PASS |
| ⏱ panel hidden by default | PASS | PASS |
| No `__SF_PERF__` global by default | PASS | PASS |
| No `sf_perf` flag by default | PASS | PASS |
| `?sf_perf=1` shows the panel button, and it opens | PASS | PASS |
| "Copy JSON" exports a snapshot with only the approved fields (`version, capturedAt, jsStartAt, requests, visits, startup, summaries`; requests: `id, endpoint, method, start, end, status, visitId`) | PASS | n/a (no clipboard access in this engine) |
| Snapshot contains no URL, id, email, token or phone | PASS (0 requests and 0 visits on the signed-out page) | n/a |
| `?sf_perf=0` clears the flag; panel hidden again | PASS | PASS |

The global `__SF_PERF__` is created lazily, on the first recorded request or screen visit. The signed-out sign-in page has neither, so it appears only after signing in. That is expected behaviour; the panel works regardless.

**Your migration files after deploy:** identical SHA-256 and modification time for all 4 files, and the same `git diff` fingerprint (`55fab27a24690933`).

**Production traffic:**
- Before the deploy, 10:12–11:33 UTC: 3,473 REST requests, 0 × 4xx, 0 × 5xx, p50 178 ms.
- After the deploy, up to 11:43 UTC: 5 requests, 0 errors, p50 176 ms.
- Too early to judge. A 24-hour error-rate and request-mix comparison against the Phase 0 baseline is to be appended.

**Limits of this verification:** it covers the signed-out experience only. Signed-in behaviour with instrumentation off was verified before deployment (side-by-side, 72/72 identical). Your iPhone session will be the first signed-in production confirmation.

## Rollback (if needed)

- Render dashboard → Deploys → roll back to the previous deploy; or
- `git revert ad0d693` on `main`, then push.

No data or schema to restore.
