# Instrumentation-only production deployment — review package

**Status: prepared, NOT deployed.** Deployment needs your explicit approval.

| | |
|---|---|
| Deployable branch | `perf/instrumentation-deploy` (local, not pushed) |
| Contents | exactly one commit, `ad0d693` "Add opt-in performance instrumentation (Phase 0)" |
| Parent | `c3967b6`, which is both current `main` and `origin/main` (verified 2026-10-15) |

The branch contains **no** docs, harness, migrations, database changes or Phase 1 work. Docs and harness live in the separate commit `6e88fe5` on `perf/phase-0-baseline`, which is not part of this deployment.

## 1. Exact changed files (19, all under `mobile/`)

**New (7):**

| File | Lines | Role |
|---|---|---|
| `mobile/src/lib/perf/perfFlag.ts` | 34 | on/off switch (default off) |
| `mobile/src/lib/perf/perfStore.ts` | 131 | in-memory recorder (bounded) |
| `mobile/src/lib/perf/perfAnalysis.ts` | 127 | pure summary math |
| `mobile/src/lib/perf/requestTracker.ts` | 47 | transparent fetch wrapper |
| `mobile/src/lib/perf/perf.test.ts` | 168 | tests |
| `mobile/src/hooks/usePerfScreen.ts` | 31 | per-screen "content showing" hook |
| `mobile/src/components/PerfPanel.tsx` | 100 | ⏱ overlay, rendered only when enabled |

**Edited (12), every line shown:**

- `mobile/src/lib/supabase.ts`
  - `+ import { withPerfTracking } from "./perf/requestTracker";`
  - `fetch: withTransportCapture(authAwareFetch, {…})` becomes `fetch: withPerfTracking(withTransportCapture(authAwareFetch, {…}), { supabaseUrl: url })`, plus a one-line comment. The inner configuration is unchanged.
- `mobile/app/_layout.tsx`
  - `+ import { PerfPanel } …`
  - `+ {Platform.OS === "web" ? <PerfPanel /> : null}`, placed after `<StudioContactFooterGate />`.
- One import plus one call each:
  - `athlete/sessions.tsx`: `usePerfScreen("athlete.home", !loading)`
  - `athlete/session/[id].tsx`: `("athlete.session", !loading)`
  - `athlete/my-sessions.tsx`: `("athlete.mySessions", !loading)`
  - `coach/sessions.tsx`: `("coach.home", !loading)`
  - `coach/session/[id].tsx`: `("coach.session", sessionSchedule != null || sessionMissing)`
  - `manager/sessions.tsx`: `("manager.home", !loading)`
  - `manager/session/[id].tsx`: `("manager.session", session != null)`
  - `ManagerDashboardScreen.tsx`: `("manager.dashboard", !loading && data != null)`
  - `ParticipantHistoryScreen.tsx`: `("participantHistory", !loading)`
  - `ParticipantAttendanceList.tsx`: `("session.roster", !loading)`

  The hook only *reads* values the screens already had. It never changes state or render output.

Review with: `git diff main perf/instrumentation-deploy`.

## 2. Disabled by default

- `isPerfEnabled()` returns **true only when all** of these hold:
  - the platform is web;
  - `localStorage.sf_perf === "1"` **on that device**, or the page was opened once with `?sf_perf=1`, which stores the flag.
- Native builds never enable it.
- The flag is read once and cached.
- Jest test "is off by default" covers this.
- **When disabled:**
  - the fetch wrapper calls the original fetch with the same arguments and returns its promise as-is;
  - `usePerfScreen` registers a focus callback and an effect that both return immediately;
  - `PerfPanel` renders `null`;
  - no listener is installed and no global is created.
- **Note:** any person can enable it *on their own device* with `?sf_perf=1`. The only effect is that they see their own request timings in the panel. Nothing leaves the device, and no other user is affected. If you prefer, it can be restricted to staff accounts in a follow-up; that's not done here.

## 3. No sensitive data collected or transmitted

- **Recorded only when enabled:**
  - endpoint labels from the existing `describeEndpoint` allowlist (`rest:profiles`, `rpc:get_required_consents`, `auth:user`, …);
  - HTTP method and status;
  - timings;
  - screen names;
  - the time of the last tap.
- **Never recorded:** URLs, hosts, query strings, ids, headers, tokens, request/response bodies, names, phones, emails.
- Jest asserts that a snapshot never contains ids, phone numbers, `select=` or the host.
- Storage: bounded in-memory ring buffers (2,000 requests, 300 visits), lost when the app closes. Only the on/off flag goes to `localStorage`.
- **Transmission:** none. The code has no network call, no reporting path and no persistence. Data leaves the device only if *you* press "Copy JSON" and paste it somewhere.

## 4. Existing behaviour unchanged

| Check | Result |
|---|---|
| Jest on the deploy branch | **723 passed**, 8 skipped (same skipped suite as `main`), including 13 new perf tests |
| `tsc --noEmit` on the deploy branch | clean |
| Lint | new files: 0 warnings; each of the 12 edited files: **identical warning count before/after** (0→0, 8→8, 2→2, 3→3, 12→12, 4→4, 2→2, 7→7, 1→1, 3→3, 5→5) |
| Wrapper transparency (Jest) | returns the same `Response` object, rethrows the same error, passes the same arguments |
| Disabled overhead (micro-benchmark) | fetch wrapper not measurable (−170 ns vs raw, noise); hook 3 ns per call |
| Bundle (production config) | 4,115,094 → 4,123,468 B raw (+8,374); gzip +2,830 B; brotli +1,997 B (+0.2–0.3%) |
| **Side-by-side behaviour, instrumentation OFF** | see §4.1 |

### 4.1 Side-by-side comparison, `main` vs deploy branch, instrumentation off

**Method:** `docs/performance/harness/compare-disabled.mjs`.
- Both branches are built from clean worktrees and run against the isolated perf stack.
- Per role: cold start → open first session → back.
- Compared per step: every Supabase request (method + path, counted), the final route, the full visible page text, and the absence of the ⏱ panel and of `globalThis.__SF_PERF__`.
- The comparison waits for 3 s with no request in flight and stable text, after a discarded warm-up pass.
- Run in both build orders, on both engines, twice each.

**Result [M-local]: 8 of 8 runs identical. 72 of 72 step comparisons matched**: the same requests (per-endpoint counts), the same route and the same visible text. The panel and the global were absent in every step. Log: [data/2026-10-15-disabled-comparison.log](data/2026-10-15-disabled-comparison.log).

| Step (per role) | Requests, main = deploy branch (all runs, both engines) |
|---|---|
| Athlete: cold start / open session / back | 40 / 11 / 20 |
| Coach: cold start / open session / back | 42 / 19 / 17 |
| Manager: cold start / open session / back | 43 / 24 / 18 |

**How the comparison was hardened before these results:**
- Earlier, unhardened passes showed two differences, both traced to capture timing on the slower first pass, not to the builds:
  - the previous/next-session row arrived about 2.3 s after a tap;
  - the roster price requests were still in flight.
- A targeted probe showed both builds render that row every time, about 2.34 s after the tap, with identical responses (6 runs each).
- The comparison now waits for network silence and stable text, after a discarded warm-up pass.

## 5. Deployment (only after your approval)

Production web hosting is Render, which builds from `main` (`render.yaml`, `buildFilter: mobile/**`). The last deploy was served about 100 s after the push.

1. Confirm `origin/main` is still `c3967b6`. If it has moved, rebase the single commit and rerun the §4 checks first.
2. `git checkout main && git merge --ff-only perf/instrumentation-deploy && git push origin main`
3. Wait for the Render deploy. Then verify:
   - `curl -s https://shira-fit-mobile-web.onrender.com/ | grep -o '/_expo/static/js/web/[^"]*'` shows a **new** bundle hash;
   - the new bundle contains `sf_perf`;
   - in a normal browser window: the app works, there is **no ⏱ button**, and `globalThis.__SF_PERF__` is `undefined` in the console;
   - with `?sf_perf=1` in your own browser: the ⏱ button appears and the panel shows timings. Open the URL with `?sf_perf=0` to turn it off again.
4. Watch for 24 h: Supabase edge-log 4xx/5xx counts and request volume per endpoint should match the baseline in `2026-10-15-phase0-baseline.md` (no new traffic is expected).

Old Home Screen PWAs keep their current bundle until their next cold start (`max-age=0` revalidation). Nothing server-side changes, so old and new clients coexist safely.

## 6. Rollback

- **Fastest:** Render dashboard → the static site → Deploys → "Rollback" to the previous deploy. This is instant and needs no git change.
- **Source of truth:** `git revert <merge or commit sha>` on `main`, then push. Render rebuilds in about 100 s.
- Users pick up the rolled-back bundle on their next app start.
- No data, schema or settings to restore.

## 7. Measuring on your iPhone Home Screen PWA (after deployment)

**Requirements:**
- your iPhone with the Shira Fit icon on the Home Screen;
- a Mac with Safari and a cable (or Wi-Fi pairing);
- **read-only use**: do not register, cancel, change attendance or record payments while measuring.

**Accounts:**
- Your own manager account for manager scenarios.
- For athlete/coach scenarios, a dedicated test account in production, if you have one; please tell me which.
- Manager "athlete preview" is not equivalent: it runs with staff permissions.

### Enable (once per Home Screen install)

1. iPhone: Settings → Apps → Safari → Advanced → **Web Inspector: on**.
2. Mac: Safari → Settings → Advanced → **Show features for web developers**.
3. Connect the iPhone and open the Shira Fit Home Screen app.
4. On the Mac: Safari → **Develop → [your iPhone] → Shira Fit** (the Home Screen app entry, not a Safari tab).
5. In that Web Inspector's **Console**, run: `localStorage.setItem("sf_perf", "1"); location.reload();`
6. A small **⏱** button appears at the bottom-left of the app.

A Home Screen app has its own storage, separate from Safari, which is why the flag must be set inside the app through Web Inspector.

### Run one measurement session (repeat 5 times)

Note your network (Wi-Fi or cellular) for each session.

1. **Cold start:** swipe Shira Fit away in the app switcher, wait 10 s, open it from the Home Screen, and wait until the calendar shows.
2. **Open a session:** tap one session in the current week, and wait until it's fully shown.
3. **Back:** go back to the calendar and wait 5 s.
4. **Manager only:** open the menu → Overview, wait; tap Month, wait; tap Global, wait; menu → Sessions, wait.
5. **Resume:** switch to another app for 60 s, return, and wait 5 s.
6. Tap **⏱ → Copy JSON**, paste into a Note or an email to yourself, and label it with the run number, role and network.

The data is in memory only, so **copy it before swiping the app away**. Swiping is the next run's cold start and clears it.

Alternative export: in the Web Inspector console, run `copy(JSON.stringify(__SF_PERF__.snapshot()))`.

### Turn off

In the Web Inspector console run `localStorage.removeItem("sf_perf"); location.reload();`, or remove and re-add the Home Screen icon.

Send me the pasted JSON files and I'll add them to `docs/performance/data/` as the **[M-device]** baseline. Desktop WebKit results are not used as a substitute.
