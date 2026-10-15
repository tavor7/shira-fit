# Phase 1 · Step 1 — Local user id instead of `auth.getUser()`: results

| | |
|---|---|
| Branch | `perf/phase1-step1-local-user-id` (local only; based on `perf/phase-0-baseline`, i.e. deployed `main` `ad0d693` plus docs) |
| Status | implemented and measured locally; **not merged, not deployed** |
| Compared against | the original Phase 0 baseline (2026-10-15), same isolated stack, same harness, same latency model |

## Scope (as approved)

- **New:** `mobile/src/lib/currentUser.ts` → `getCurrentUserId()` reads the signed-in user's id from the locally stored session (`supabase.auth.getSession()`). There is no Auth-server round trip; an expired access token is refreshed first.
- **Replaced at 16 call sites in 11 files:**
  - `trainingSessionQueries.fetchAthleteOpenSessionsForCalendar`;
  - `homePriorityAlerts.fetchAthleteMultipleSessionsPerDayItems` and `fetchAthleteWaitlistOpenSpotItems`;
  - `waitlistSpotNotifier.checkWaitlistSpotsAndNotify`;
  - `managerDirectMessages.searchMessageRecipients`;
  - `AthleteNextSessionHero` `loadStatus` and `onRegister`;
  - athlete `sessions.tsx` (`load`, `loadMyUpcoming`), athlete `session/[id].tsx` (`load`, `register`, waitlist leave), athlete `my-sessions.tsx`;
  - coach `session/[id].tsx`, `session/manage/[id].tsx`, `create-session.tsx`.
- **Kept on `getUser()` deliberately:** `pushTokenSync`, `webPushSync`. They write the user's push subscription.

## Authorization review (every call site)

| Use of the id | Sites | Why server authority is unchanged |
|---|---|---|
| Filter the user's **own** rows on reads (`session_registrations`, `waitlist_requests`, `profiles.full_name`) | athlete home/detail/my-sessions, alerts, hero, waitlist notifier, coach create | RLS restricts every read to what the JWT's user may see. A wrong id could only return fewer rows, never someone else's data. |
| Same-day registration warning before registering | athlete detail, hero | Read-only prompt. `register_for_session` derives the athlete from `auth.uid()` and re-checks everything. |
| Leave waitlist: `DELETE waitlist_requests … eq(user_id)` | athlete detail | RLS `waitlist_delete_self`: `user_id = auth.uid() OR is_manager(auth.uid())`. |
| Exclude self from message recipients | manager direct messages | Cosmetic. |
| UI gating (show edit / delete-own-note / "forbidden") | coach session pages | Direct `training_sessions` writes are manager-only under RLS. The note RPCs check `auth.uid()`. The UI decision is not authority. |

The id comes from the same stored session whose access token authorizes the next request, so the two cannot disagree.

**Observed, out of scope, not changed:** the coach "manage session" page writes `training_sessions` directly, which RLS allows only for managers. A coach's save there may silently update no rows. Worth a separate check.

## Checks

| | Result |
|---|---|
| Jest | **727 passed**, 8 skipped (Phase 0: 723), including 4 new tests: the helper uses the local session and never `getUser`; returns null when signed out or unreadable; and a **static guard** fails if `auth.getUser(` appears anywhere outside the two allow-listed push syncs. Guard proven with a temporary offending file, which failed and was then removed. |
| `tsc --noEmit` | clean |
| Lint | new files clean; each of the 11 edited files has an identical warning count before/after |
| Harness | Chromium 15/15 and WebKit 15/15 runs successful; dataset unchanged afterwards (2,658 registrations) |

## Results vs the Phase 0 baseline [M-local]

Median of 5 runs. Full tables: [Chromium](data/2026-10-15-phase1-step1-vs-baseline-chromium.md), [WebKit](data/2026-10-15-phase1-step1-vs-baseline-webkit.md).

| Role | Metric | Baseline (Chromium / WebKit) | Step 1 (Chromium / WebKit) | Change |
|---|---|---|---|---|
| Athlete | **Cold start → home content** | 3,354 / 3,552 ms | **2,660 / 2,880 ms** | **−694 / −672 ms (−21% / −19%)** |
| Athlete | Home requests before content / depth | 34 / 7 | 29 / 5 | −5 requests, −2 sequential round trips |
| Athlete | **Open session: tap → content** | 1,317 / 1,470 ms | **1,047 / 1,182 ms** | **−270 / −288 ms (−21% / −20%)** |
| Athlete | Open session: all settled | 2,060 / 2,293 ms | 1,529 / 1,728 ms | −531 / −565 ms (−26% / −25%) |
| Athlete | **Back to home: content hidden by skeleton** | 1,752 / 1,876 ms | **1,182 / 1,286 ms** | **−570 / −590 ms (−33% / −31%)** |
| Athlete | Back to home: requests / depth | 20 / 7 | 15 / 5 | −5 requests, −2 round trips |
| Athlete | `auth:user` requests: cold start / open session / back | 9 / 2 / 7 | **4 / 0 / 2** | −5 / −2 / −5 |
| Coach | **Open session: tap → content** | 518 / 576 ms | **252 / 284 ms** | **−266 / −292 ms (−51%)** |
| Coach | Open session: depth before content | 3 | 1 | −2 round trips |
| Coach, manager | everything else | — | — | unchanged, within run-to-run noise |

**Only change above +5% / +50 ms:** manager cold start in Chromium, +64 ms (+2%). WebKit shows +7 ms for the same metric. Step 1 changed no code on the manager's cold-start path, and the baseline's own run-to-run spread for this metric is about 80 ms (p90 − median). Classified as noise, **not a regression**.

**Not changed by design:** startup shell (6 sequential requests; Step 2), returning-to-home skeletons for coach and manager (Step 5), resume (Phase 2).

## Remaining `auth:user` calls, and a decision for you

The remaining calls come from the **push-subscription syncs**:
- 2 on every cold start, for all roles: the once-per-login sync in `(app)/_layout.tsx`;
- 2 more on every athlete-home focus: `athlete/sessions.tsx` re-runs both syncs on **every focus**, which predates the once-per-login sync.

They were kept on `getUser()` by design, because they write the push subscription.

Options, not implemented:
- **A.** Keep as is.
- **B.** Remove the per-focus re-sync from the athlete home, relying on the once-per-login sync plus the notification-settings screen. This saves 2 sequential-independent requests per athlete home visit.
- **C.** Switch the push syncs to `getCurrentUserId()`. Their writes are already RLS-guarded (`auth.uid() = user_id`).

B changes when push subscriptions are refreshed, so it needs your product decision. Recommendation: B, scheduled with Phase 2 (resume and duplicate handling).

## Real device

**[Pending device]** These are local measurements with modelled latency. Improvements on your iPhone will be confirmed from the Home Screen PWA data once you collect it.
