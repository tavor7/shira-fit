# Phase 1 · Step 5 — Keep content on screen while it refreshes: results

| | |
|---|---|
| Branch | `perf/phase1-step5-keep-content` (local only; on top of Step 4). Code commit `7fd6656`. |
| Status | implemented and measured locally; **not merged, not deployed**; no database changes; no authorization changes |
| Compared against | the Phase 0 baseline **and** Step 4; same isolated stack, harness and latency model |

## What changed

**Before:**
- Every return to a home screen replaced the loaded calendar with skeletons until a full reload finished.
- So did every realtime event on the manager home, and every refocus of a session roster.
- The calendar was unmounted each time, so its week, scroll position and open state reset.
- **A failed refresh emptied the coach and manager calendars**, which then showed an empty week.

**Now** (home screens of all three roles, My Sessions, and the participant roster):

| Rule | How |
|---|---|
| **Skeletons only on a first load** | `showInitialSkeleton(loading, hasData)`. A background refresh (focus, realtime, back-navigation) keeps the content mounted and visible. |
| **Newest result wins** | each load takes a ticket (`createLoadSequencer`). An older, slower response can't overwrite a newer one, and only the newest load ends the loading state. |
| **No half-updated calendar** | sessions and their capacity counts are applied together. A refresh never shows new sessions with old counts. |
| **Failed refresh keeps the data** | the calendar stays, with a notice: *"Couldn't refresh — showing what was loaded earlier."* plus *Try again*. That way, counts and places aren't taken as current. The manager home previously showed no error at all; it now gets the same handling, and an error with retry on a failed first load. |
| **Account changes** | each of these screens is wrapped in `UserScopedScreen`, keyed by the signed-in user id. A different account always starts from an empty screen, so kept data can never carry over. Logout already unmounts these screens. |
| **Roster** | a refocus refreshes silently **only if the rows on screen belong to the same session**. Adjacent-session navigation reuses the component, so a different session still gets a first-load skeleton, never the previous session's rows. |

**Unchanged:**
- **Registration eligibility.** Every register / cancel / waitlist action is still decided by the server.
- **The athlete session page** still shows its actions only after a fresh load (Step 4).
- **Request counts** (see below).
- **Polling:** none added.

**Files:**
- New: `src/lib/screenRefresh.ts` (+ tests), `src/components/UserScopedScreen.tsx`, `src/components/RefreshFailedNotice.tsx`.
- Edited: the athlete, coach and manager home screens, `athlete/my-sessions.tsx`, `ParticipantAttendanceList.tsx`, and one new en/he string.

## Verification [M-local]

| Check | Result |
|---|---|
| **What users see**, Step 4 build vs Step 5 build ([script](harness/compare-ui.mjs)), Chromium **and** WebKit | **40 of 40 identical**: 12 home and My Sessions scenarios plus 8 session-detail scenarios, × 2 engines (all visible text and accessibility labels, after the data settled) |
| **Behaviour, measured from the DOM** ([script](harness/verify-keep-content.mjs)): the week calendar is rendered vs replaced by skeletons, sampled every 50 ms | see the next table |
| Jest | **762 passed**, 8 skipped. +7 new tests: the skeleton rule, newest-result-wins with an out-of-order pair, independent sequencers, and a guard that the four screens stay user-scoped. **1 failure, not caused by this step:** the Step 1 `getUser` guard finds an untracked file `src/lib/currentUser.test 2.ts` (see "Untracked duplicate files" below). |
| `tsc --noEmit` | clean |
| Lint | every edited file has identical warnings before / after; new files clean |

| DOM behaviour (3 runs each) | Step 4 build, Chromium / WebKit | **Step 5 build**, Chromium / WebKit |
|---|---|---|
| Back to athlete home: calendar hidden | 516–616 / 531–588 ms | **0 / 0 ms** |
| Back to coach home | 460–497 / 487–543 ms | **0 / 0 ms** |
| Back to manager home | 441–507 / 492–535 ms | **0 / 0 ms** |
| Manager home during a realtime registration add + remove | 1,022 / 1,017 ms hidden | **0 / 0 ms** |
| Refresh fails (session requests blocked) | skeleton while postgrest-js retries (1 s, 2 s, 4 s); afterwards the coach and manager calendars are **empty** (by code: `setRows([])` on error) | **calendar stays throughout; notice shown** (all 3 roles, both engines) |
| Account switch (athlete A logs out, athlete B logs in): frames showing A's registration badges | 0 | **0** |

## Results [M-local] — median of 5 runs (harness instrumentation)

Full tables: [Chromium](data/2026-10-15-phase1-step5-vs-baseline-chromium.md), [WebKit](data/2026-10-15-phase1-step5-vs-baseline-webkit.md).

| Role | Metric (Chromium / WebKit) | Baseline | Step 4 | **Step 5** | Δ vs baseline |
|---|---|---|---|---|---|
| Athlete | **Back to home: content hidden by skeleton** | 1,752 / 1,876 | 589 / 858 | **0 / 0 ms** | −100% |
| Coach | Back to home: hidden | 1,325 / 1,492 | 521 / 539 | **0 / 0 ms** | −100% |
| Manager | Back to home: hidden | 1,347 / 1,517 | 471 / 504 | **0 / 0 ms** | −100% |
| Manager | **Realtime registration: skeleton flash** | 1,366 / 1,368 | 496 / 608 | **0 / 0 ms** | −100% |
| Athlete | Cold start → content | 3,354 / 3,552 | 1,311 / 2,456* | 1,211 / 1,409 ms | −64% / −60% |
| Coach | Cold start → content | 2,807 / 3,103 | 1,388 / 1,409 | 1,104 / 1,233 ms | −61% / −60% |
| Manager | Cold start → content | 2,815 / 3,088 | 1,098 / 1,472 | 1,132 / 1,200 ms | −60% / −61% |
| Athlete | Open session: tap → content | 1,317 / 1,470 | 244 / 365 | 252 / 274 ms | −81% |
| Manager | Menu → Sessions: tap → content | 1,494 / 1,546 | 602 / 729 | 566 / 594 ms | −62% |
| Manager | Session roster: focus → content | 1,264 / 1,431 | 645 / 791 | 648 / 746 ms | −49% / −48% |
| Coach / manager | Cold start: all requests | 42 / 42–43 | 36 / 35–36 | **34 / 33–34** | −8 / −9 |
| All | Back to home / realtime / resume: requests in 5 s | — | 15–18 / 34 / 8 | **unchanged** | |

\* Step 4's WebKit athlete cold start was disturbed by machine load (see the Step 4 report; back-to-back re-run 1,526 ms).

**Notes:**
- **Cold start (−2 requests, coach / manager).** One request each for `active_registration_counts` and `session_notes`. These come from the staff overview panel, which reloads whenever the home finishes a load. Previously, a load superseded by a newer one still finished and triggered an extra overview reload; now only the newest does. Same screens (verified identical).
- **What "content hidden" now means.** On back-navigation and realtime, the previous content stays visible while fresh data loads in the background. It's replaced in a single update about 0.5 s later (one round-trip wave, unchanged from Step 4). During that interval, counts and badges are the values from just before; actions are still validated by the server.

**Regressions:** none found. No metric is worse than Step 4 beyond noise. Dashboard → Global improved (−353 / −170 ms vs Step 4), but that's server-dominated and not touched by this step.

## Untracked duplicate files (needs your decision)

Untracked copies with " 2" in the name appeared during today's branch switches:
- `mobile/src/lib/currentUser 2.ts`, `currentUser.test 2.ts`
- `authEvents 2.ts`, `authStartup.test 2.ts`, `signupSync 2.ts`
- `athleteCalendarMerge 2.ts`, `athleteCalendarMerge.test 2.ts`
- `mobile/package-lock 2.json`

**Likely cause:** macOS / iCloud Desktop sync recreating files that a checkout removed. `currentUser 2.ts` is byte-identical to `currentUser.ts`.

**I have not deleted them.** They aren't committed anywhere. Their only effect: the Step 1 guard test reads `currentUser.test 2.ts` and fails. Deleting them (or moving the project out of the synced Desktop) fixes that.

## Remaining opportunities (later steps)

- Same "keep content" treatment for the other screens that reload with skeletons on focus: subscriptions, activity log, staff users, roster calendar, birthday messages, capacity mismatch.
- **Step 6:** remove the register / cancel artificial delays and add the S4 scenario.
- **Step 7:** bounded calendar range and adjacent-week prefetch.
- **Phase 2:** shared navigation badges and consent / terms gates, which are the remaining duplicate requests on resume (8 per resume).
- **Phase 3:** batched pricing and `manager_weekly_stats` v2 (database changes, separate approval).

## Real device

**[Pending device]** Local measurements with modelled latency. Behaviour on your iPhone Home Screen PWA still needs your confirmation.
