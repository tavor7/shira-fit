# Performance Phase 1 (Steps 1–5) — production readiness, roadmap and release plan (2026-10-16)

| | |
|---|---|
| Release candidate | `perf/phase1-step5-keep-content` @ `d469413` (local, not pushed). It contains Phase 0 (already in production) and Steps 1–5 as a straight line on top of production `main` (`ad0d693`). |
| Status | **ready for your approval. Nothing merged, pushed or deployed.** |

## 1. All five steps are present, nothing was lost

Every step's code and docs commit is an ancestor of the release candidate. The history is linear:
`a0aece4` Step 1 → `bda33c4` Step 2 → `6047f6f` Step 3 → `fd7d296` Step 4 → `7fd6656` Step 5 → `d469413` fix found during this review.

The step-specific checks were re-run on the final build (below), so every step's behaviour is verified in the combined result, not only in its own branch.

## 2. Verification of the release candidate against production `main` (2026-10-16)

Fresh builds of production `main` (`ad0d693`) and of the release candidate, isolated perf stack, Chromium **and** WebKit.

| Requirement | Check | Result |
|---|---|---|
| Nothing users see changed | [compare-ui](harness/compare-ui.mjs): 12 home / My Sessions + 8 session-detail scenarios (athlete registered / not open / open / waitlisted, coach, manager, walk-ins only, super user) | **40 / 40 identical** |
| Authentication and consent correct | [verify-auth-consent](harness/verify-auth-consent.mjs), 6 scenarios: normal sign-in; legal gate required (shown, still shown after resume); signup consents pending (recorded once, gate never flashes); account switch; pending → approved on resume; disabled on resume | **identical on both engines, and identical under heavy CPU load** (see §3) |
| Registration / waitlist / calendar data unchanged | [verify-athlete-queries](harness/verify-athlete-queries.mjs): old vs new queries for 40 athletes (calendar incl. 440 hidden registered sessions, My Sessions, registered / waitlist badges) | **identical** |
| Realtime updates correct | manager home: a registration added then removed in the database | screen **updates on add and returns to the original on remove**, with **0 ms** hidden |
| Background refresh keeps content | [verify-keep-content](harness/verify-keep-content.mjs): back to home, all 3 roles | **0 ms hidden** (production `main`: 0.44–0.74 s) |
| Failed refresh keeps data | session requests blocked during a refresh | content kept, "couldn't refresh" notice shown (all roles) |
| No previous-user data after an account switch | athlete A logs out, athlete B logs in, screen sampled every 50 ms | **0 frames** with A's data |
| Subscription and payment behaviour | no subscription / payment / registration logic was changed in Phase 1 (code review). The screens and data checks above are identical. Server functions untouched. | unchanged |
| Unit / static | Jest **763 / 763**, `tsc` clean, lint unchanged per file | pass |

## 3. Found and fixed during this review: consent-gate flash under load

- **Symptom.** A brand-new user whose signup consents were still being recorded could see the legal-consent gate flash briefly. This is exactly what Step 2 meant to prevent.
- **Detection.** The release check showed it once in Chromium. Under deliberate CPU load it reproduced in **3 of 16** runs on Step 5, and **0 of 16** on production `main`. So it was a Phase 1 regression, missed because the Step 2 check ran on an idle machine.
- **Cause.** On a non-blocking profile load (background auth event), the new profile rendered while the signup sync still looked "settled", for a moment.
- **Fix** (`d469413`, 3 lines in `AuthContext.tsx`). The sync is marked pending before the profile request, for users whose sync hasn't run yet.
- **Result.** **0 of 24** under the same load. All 6 auth scenarios are identical to production on both engines and under load. Consents are still recorded exactly once.

## 4. Measured effect of Steps 1–5 (local, modelled 190 ms latency; medians)

| | Phase 0 baseline | **Steps 1–5** |
|---|---|---|
| Cold start → content (athlete / coach / manager) | 3.4–3.6 / 2.8–3.1 / 2.8–3.1 s | **1.2–1.4 / 1.1–1.2 / 1.1–1.2 s** (−60 to −64%) |
| Open a session (athlete) | 1.3–1.5 s | **0.25–0.27 s** (−81%) |
| Session roster (manager) | 1.26–1.43 s | 0.65–0.75 s (−48%) |
| Back to home, content hidden | 1.3–1.9 s | **0 ms** |
| Realtime update skeleton (manager) | 1.37 s | **0 ms** |
| Requests on cold start / resume | 40–43 / 12 | 29–34 / 8 |
| Athlete longest URL | 11,269 chars (growing weekly) | 339 chars (fixed) |

Real iPhone Home Screen measurements are still pending. These are desktop-browser numbers with modelled latency.

## 5. Proposed resolution of the `coach/sessions.tsx` conflict (not merged)

**Trial merge.** Done in a throwaway worktree, without committing (no branch was moved): the release candidate plus `security/coach-session-permissions` @ `e17ba1b` (later commits on that branch change only its test harness).
- **One conflicting hunk.** Security deleted `void maintainSessionSeriesHorizon();`; performance rewrote the request block next to it (parallel requests, Step 5 sequence guard).
- **Resolution.** Keep the performance block and drop that one line. Everything else merged automatically:
  - the security removals (import, horizon call, "Add session" handler, coach session page, roster gating);
  - the performance code (parallel loads, sequence guard, skeleton rule, user scoping).
- **Shape of the result.** The resolved file differs from the performance branch **only** by the three security edits, and from the security branch only by the performance code.

**Combined result, tested in isolation:**
- `tsc` clean; Jest **773 / 773** (763 performance + 10 security route tests); lint unchanged in all overlapping files.
- Coach permission browser test on the security stack, combined build: **20 / 20 in 10 consecutive runs** (6 Chromium, 4 WebKit)
- Screens on the perf stack, combined vs release candidate: home and My Sessions **12 / 12 identical**. Session detail: **7 / 8 identical**; the one difference is the intended one, "Edit session" absent from the coach session page (one accessibility label fewer).
- Keep-content behaviour, combined build: all green: back to home and realtime 0 ms hidden, realtime updates arrive, a failed refresh keeps the data with the notice, account switch shows no previous-user data
- The database suites (179, 180, 163–165, 135) are independent of the app build and pass on the security stack.

## 6. Roadmap

| Item | What | Expected benefit | Status |
|---|---|---|---|
| Steps 1–5 | startup, home screens, session detail, keep content | measured above | **ready** |
| **Step 6** | decouple the success animation from the data update after register / cancel; add the register / cancel scenario (S4) to the harness | the two most important athlete actions. In the session page (`athlete/session/[id].tsx`) the screen waits **780 ms** after a successful registration and **500 ms** after a cancellation before updating, then reloads names (and, on cancel, the count) **one after the other**. Expected: about **0.7–1 s** faster per action, with the animation kept. **Not yet measured:** S4 doesn't exist yet, so that's the first part of the step. | not started (your approval) |
| **Step 7** | bounded calendar range (load the visible weeks instead of everything up to the browse end) and prefetch of the adjacent week | smaller responses that no longer grow with history (staff calendars load all sessions); instant week switching. Benefit grows with data size; production staff calendars are the main gainers. | not started |
| **Phase 2** | shared navigation badges (one source, 60 s / realtime freshness instead of per-header polling); shared consent / terms / address gates (today 7 duplicate checks per resume); one resume handler; push-sync redesign (sync only on login, permission or token change, relevant resume, expiry) | resume from 8 requests to ~2–3; fewer profile reads on cold start; less battery and data use | design approved in principle, not started |
| **Phase 3** (database, separate approval) | batched pricing for rosters (one call instead of one per participant); `manager_weekly_stats` v2 (global mode takes ~4.4 s in production) | manager dashboard global view from seconds to sub-second; roster load without N price calls | not started |
| Also | keep-content for the remaining screens with skeletons on refocus (subscriptions, activity log, staff users, roster calendar, birthdays, capacity mismatch) | removes the remaining refocus flashes | small follow-up |

## 7. Recommended deployment strategy for Steps 1–5

- **Ship as one app release.** The steps build on each other and have been verified together. It's client-only, with no database changes and no new endpoints. Old PWA clients are unaffected until they update.
- **Order with the security release** (see the combined sequence in the final report):
  1. the security migration first;
  2. then **one app release from the combined branch**: performance + coach UI, with the resolution in §5.

  One app deploy is safer than two back-to-back deploys that touch the same file.
- **Before deploying:**
  - re-run §2 on the final combined build;
  - capture the production perf panel baseline on your iPhone (`?sf_perf=1`), athlete and staff, so before/after are comparable on a real device.
- **After deploying:**
  - **verification:** hard-refresh, confirm the new bundle hash, perf panel on iPhone (cold start, open session, back to home), consent gate checks with a fresh test account;
  - **watch for 48 h:** edge 4xx/5xx rates, request volume (expected down), system-monitoring client errors, consent-record anomalies (duplicates must stay at zero).
- **Rollback:** Render rollback to the previous build. The client-only change has nothing to undo on the server.
