# Phase 1 · Step 3 — Home screens in parallel and the athlete URL growth fix: results

| | |
|---|---|
| Branch | `perf/phase1-step3-home-parallel` (local only; on top of Step 2). Code commit `6047f6f`. |
| Status | implemented and measured locally; **not merged, not deployed**; no database changes; no RLS or authorization changes |
| Compared against | the Phase 0 baseline **and** Step 2; same isolated stack, harness and latency model |

## What changed

| Screen | Before | After |
|---|---|---|
| **Athlete home** | ~7 sequential steps. The calendar query carried **every registered session id** in the URL (`or=(is_hidden.eq.false,id.in.(…))`). The registered/waitlist badges then sent **every calendar session id** twice more. | **One wave:** visible sessions ∥ the athlete's registered hidden sessions (a join) ∥ alerts ∥ own registrations ∥ own waitlist ∥ week notes. Then the capacity counts. Own rows are fetched **by user id** and matched to the calendar in the app. **No id lists in any athlete calendar URL.** |
| **My Sessions** | own registrations → then `training_sessions?id=in.(all of them)` | one join: `session_registrations(me, active) → training_sessions` |
| **Coach / manager home** | sessions → 3 counts → alerts → hidden markers → notes (5 steps; the calendar waited for alerts) | sessions ∥ week notes → 3 counts ∥ hidden markers (super user) → **calendar shown**. Alerts are computed afterwards, with a guard so an older, slower result can't overwrite a newer one. |
| **Staff overview** | teaching counts → then note previews | in parallel |

**Not changed, deliberately:**
- `open_next_week_sessions_if_due` is still called on each home visit. It opens next week's registration at the opening time even if the cron is late. Throttling it could delay opening for an athlete waiting on the home screen, at the exact moment athletes compete for spots. It's fire-and-forget and doesn't block the screen.
- `maintain_session_series_horizon` is kept for the same reason.
- The duplicate studio-notes fetch on the first home load: one parallel, non-blocking request. Low value, and left for later to keep this step small.

**Files:**
- `src/lib/trainingSessionQueries.ts` (`fetchAthleteOpenSessionsForCalendar`, which also serves previous/next navigation)
- new `src/lib/athleteCalendarMerge.ts` and its tests
- `app/(app)/athlete/sessions.tsx`, `app/(app)/athlete/my-sessions.tsx`, `app/(app)/coach/sessions.tsx`, `app/(app)/manager/sessions.tsx`
- `src/components/StaffHomeOverview.tsx`

## Correctness verification [M-local]

| Check | Result |
|---|---|
| **Old vs new athlete queries**, through the real Auth/PostgREST/RLS path, 40 synthetic athletes ([script](harness/verify-athlete-queries.mjs)) | **Identical for all 40:** calendar (same sessions, same field values; only JSON key order differs in joined rows, which the app doesn't depend on), My Sessions, and registered/waitlist badges. Covered **440 hidden sessions** the athletes are registered in. |
| **What users see**, Step 2 build vs Step 3 build ([script](harness/compare-ui.mjs)), Chromium **and** WebKit | **24 of 24 scenarios identical**: all visible text and all accessibility labels (registration and waitlist badges are labels), after the data settled. Three athletes (including the heaviest, 196 registrations) × this week, next week and My Sessions; coach home; manager home; super-user home with hidden-athlete markers. |
| Jest | **756 passed**, 8 skipped (Step 2: 749). +7: merge order and de-duplication, calendar matching, and a **guard** that fails if an `id.in.(…)` / `.in("id"\|"session_id", …)` filter returns to the athlete calendar paths. Proven by injecting one: the test failed and was reverted. |
| `tsc --noEmit` | clean |
| Lint | new files clean; every edited file has an identical warning count before/after |
| Data | isolated dataset unchanged after all runs (2,658 registrations) |

## Results [M-local] — median of 5 runs

Full tables: [Chromium](data/2026-10-15-phase1-step3-vs-baseline-chromium.md), [WebKit](data/2026-10-15-phase1-step3-vs-baseline-webkit.md).

| Role | Metric (Chromium / WebKit) | Baseline | Step 2 | **Step 3** | Δ vs baseline | Δ vs Step 2 |
|---|---|---|---|---|---|---|
| Athlete | **Cold start → content** | 3,354 / 3,552 | 1,751 / 2,013 | **1,223 / 1,420 ms** | **−64% / −60%** | −30% / −29% |
| Coach | **Cold start → content** | 2,807 / 3,103 | 1,983 / 2,160 | **1,161 / 1,271 ms** | **−59% / −59%** | −41% / −41% |
| Manager | **Cold start → content** | 2,815 / 3,088 | 1,927 / 2,183 | **1,166 / 1,506 ms** | **−59% / −51%** | −39% / −31% |
| Athlete | Home: sequential depth before content | 7 | 5 | **2** | −5 | −3 |
| Coach / manager | Home: sequential depth before content | 6 | 6 | **3** | −3 | −3 |
| Athlete | **Back to home: content hidden by skeleton** | 1,752 / 1,876 | 1,175 / 1,341 | **573 / 569 ms** | **−67% / −70%** | −51% / −58% |
| Coach | Back to home: hidden | 1,325 / 1,492 | 1,348 / 1,547 | **500 / 581 ms** | −62% / −61% | −63% / −62% |
| Manager | Back to home: hidden | 1,347 / 1,517 | 1,352 / 1,553 | **530 / 575 ms** | −61% / −62% | −61% / −63% |
| Manager | Menu → Sessions: tap → content | 1,494 / 1,546 | 1,372 / 1,570 | **569 / 717 ms** | −62% / −54% | −59% / −54% |
| Manager | Realtime registration: skeleton flash | 1,366 / 1,368 | 1,352 / 1,391 | **488 / 562 ms** | −64% / −59% | −64% / −60% |
| Athlete | Open session: all settled | 2,060 | 1,540 | **1,347 ms** | −35% | −13% |
| Athlete | **Longest request URL** (same harness) | — | **11,269 chars** (growing) | **339 chars** (fixed) | | −97% |

Request counts are unchanged by this step (it reorders requests, it doesn't remove them). The athlete calendar no longer depends on how many sessions exist.

**Items flagged by the regression scan, and the outcome:**
- **"Home screen mounts at":** +43 to +75 ms vs Step 2 in the first run, although Step 3 changes nothing that runs before the home screen mounts. **Back-to-back re-run of the Step 2 and Step 3 builds, same conditions:** athlete 570 vs 576 ms, manager 585 vs 569 ms. **No difference.** The shift was environment drift between sessions. The same back-to-back run confirms the content gain: athlete 1,770 → 1,156 ms, manager 1,945 → 1,104 ms.
- **Dashboard → Global:** +54 ms (Chromium) / +181 ms (WebKit) vs Step 2. Run ranges overlap (Step 2 1,619–1,976 / 1,722–2,102; Step 3 1,734–2,781 / 1,759–2,354). It's dominated by the slow server function (Phase 3), and Step 3 doesn't touch the dashboard. **Noise.**
- **Coach session detail:** 8 requests / depth 2 before content (WebKit) vs 7–8 / 1–2 in Step 2's own runs. **Within range.**

**A bounded list remaining (staff only):** the "athlete booked twice on the same day" alert sends the ids of **upcoming** sessions only, about 5 weeks ahead (longest staff URL 4,955 chars locally). It doesn't grow with history and now runs after the calendar is shown. Phase 3 (calendar scope) will shrink it.

## Real device

**[Pending device]** Local measurements with modelled latency. Improvements on your iPhone Home Screen PWA will be confirmed from your measurements.
