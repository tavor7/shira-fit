# Phase 1 — Proposed implementation sequence (for approval)

Ordered by the Phase 0 measurements ([2026-10-15-phase0-baseline.md](2026-10-15-phase0-baseline.md)) and your priorities: first opening, startup, auth/profile, waterfalls, time to meaningful content.

Expected gains are **[E]**: measured round-trip counts × the modelled ~190–210 ms per round trip. Each step is re-measured with the harness (Chromium and WebKit, 5 runs) before it counts as done. Real-iPhone confirmation stays **[Pending device]**.

## Ground rules for every step

- One small commit per step, on a local branch.
- `jest`, `tsc --noEmit` and lint on every step, plus the per-file lint before/after comparison.
- Harness before/after, recorded in `docs/performance/`.
- No push, deploy or migration without your explicit approval.
- No RPC response contract changes. Phase 1 is client-only, with no database changes.
- Compatible with older PWA clients by construction, since nothing server-side changes.
- Registration, capacity, attendance, payment and subscription actions stay server-validated. Action buttons are never enabled on stale status.

## Sequence

### 1A — Startup and identity (first opening)

**Step 1: local user id instead of `auth.getUser()` (C4).**
- Files: 16 hot call sites. They are listed in `shira-fit-performance-plan.md` §1.2: athlete home and detail, my sessions, coach session pages, `trainingSessionQueries`, `homePriorityAlerts`, `AthleteNextSessionHero`, `managerDirectMessages`, `waitlistSpotNotifier`.
- Measured today: athlete home `auth:user` × 9 on cold start, × 7 on return; production 527/day, p50 216 ms.
- Authorization: every write that takes a user id is already checked against `auth.uid()` server-side. RLS restricts every read.
- Test: a static guard that fails if `auth.getUser(` comes back in hot paths.
- [E] Athlete: 1–2 fewer sequential hops on home and detail.

**Step 2: auth bootstrap and profile loading (C7), plus memoized context values.**
- The startup spinner waits only for `getSession` + the first profile fetch: **6 sequential shell requests → 2**.
- The three `sync_signup_*` RPCs run once per user per app session, off the critical path.
- The consent and receipt gates wait for that sync on a user's first load only, so a new user never sees a false requirement flash.
- Ignore `INITIAL_SESSION` and same-user `SIGNED_IN`/`TOKEN_REFRESHED` instead of reloading the profile.
- `useMemo` the Auth and I18n context values.
- [E] Home screen mounts ≈0.8 s earlier on every cold start. Resume: −5 requests and fewer full-app re-renders.
- Manual matrix:
  - login, logout, account switch;
  - signup → email confirmation → first login, in the preview environment;
  - password reset;
  - token expiry;
  - PWA resume.

### 1B — Waterfalls and loading states

**Step 3: home screens, parallel loading.**
- Files:
  - athlete [sessions.tsx](../../mobile/app/(app)/athlete/sessions.tsx);
  - coach and manager `sessions.tsx`;
  - `fetchAthleteOpenSessionsForCalendar`;
  - `StaffHomeOverview` (the counts → notes part only).
- Changes:
  - The calendar renders as soon as sessions and counts arrive. Alerts and the overview load after it, without blocking.
  - The athlete's own registrations and waitlist are fetched by user id. That **removes the growing-URL risk (H5)**.
  - Remove the duplicate studio-notes fetch.
  - Throttle the two write RPCs fired on every focus to once per 10 min (C11).
- [E] Athlete home depth 7 → 3, staff homes 6 → 2–3 to calendar: ≈0.6–1.0 s.

**Step 4: detail screens.**
- Files: athlete session detail, `ParticipantAttendanceList`, coach session pages.
- Changes:
  - Parallel request waves.
  - Progressive render: the header shows when the session row arrives, and actions stay disabled until fresh status arrives.
- [E] Athlete detail tap → content 1.3 s → ≈0.3–0.5 s. Roster ≈1.3 s → ≈0.6 s.
- The per-row price RPCs remain until the batched pricing step (Phase 3, which needs a database change).

**Step 5: keep valid content during refresh (stale-while-revalidate).**
- Calendars (athlete, coach, manager, roster calendar), roster, my sessions.
- The skeleton shows only when there is no data yet. Refresh errors keep the data and show a toast.
- [M-local] baseline: 1.3–1.9 s of skeleton on every return, and a 1.37 s flash on every realtime event. [E] → 0.

**Step 6: post-register/cancel delays (C14), plus S4 added to the harness on the isolated stack.**
- The animation runs concurrently with the refreshes and the reminder scheduling.
- [E] ≈0.6–1.0 s faster from tap to the final state.

### 1C — Payload (moved earlier, as requested, before any caching layer)

**Step 7: bounded calendar fetch (C9) and previous/next session without the full list (C15).**
- Fetch the visible week ± neighbours, with prefetch.
- Previous/next session uses keyset queries.
- [M-prod] The full-history `training_sessions` select runs at p50 402 ms on the edge, versus ~190 ms for small requests. [M-local] Staff home: 123 KB gzip per cold start, 116 KB per return.
- [E] Payload −80–90%, and −1 large request per detail open.
- Bandwidth isn't modelled locally, so the main gain here is [Pending device] / production-measurable.

## After Phase 1 (unchanged from the approved plan)

- **Phase 2:** shared nav badge state (60 s, realtime where appropriate); shared gate checks with the 5-minute terms policy; a resume handler.
- **Phase 3:** batched roster pricing and the `manager_weekly_stats` v2. Each needs a separate production approval.
- **Phase 4:** caching, bundle splitting, rendering.

## Real-device measurement

To get an iPhone Home Screen PWA baseline **before** Phase 1 changes reach users, I recommend deploying the Phase 0 instrumentation alone first. The change set is listed in the baseline report §4: inert, +2.8 KB gzip. You would enable it only on your phone and capture the same scenarios read-only. This needs your explicit approval.
