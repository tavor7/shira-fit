# Phase 1 · Step 2 — Startup and profile loading: results

| | |
|---|---|
| Branch | `perf/phase1-step2-startup` (local only; on top of Step 1 `perf/phase1-step1-local-user-id`) |
| Status | implemented and measured locally; **not merged, not deployed**; no database changes |
| Compared against | the original Phase 0 baseline **and** Step 1; same isolated stack, harness and latency model |

## What changed

| Before (measured in Phase 0) | After |
|---|---|
| The startup spinner waited for **6 sequential requests**: profile → `sync_signup_profile_from_metadata` → `sync_signup_electronic_receipts_consent` → `sync_signup_legal_consents` → profile | The spinner waits for **2**: session + profile row. The signup sync runs **in the background, at most once per user per app session**: profile sync first, then the two consent syncs in parallel (`src/lib/signupSync.ts`). |
| The `INITIAL_SESSION` echo after bootstrap re-ran the whole 5-request chain | Ignored when it's the same user (`src/lib/authEvents.ts`) |
| Every tab/PWA resume (`SIGNED_IN`, same user) re-ran the chain and replaced the session object, re-rendering the whole app | Keeps the session object when the token is unchanged. Re-reads **only the profile row**, at most every 30 s, so approval, disable and role changes still arrive on resume. |
| Token refresh reloaded the profile chain | Updates the session only |
| Profile re-read after every sync | Re-read only if the sync could have changed something: an empty field it fills, or a recorded receipts consent. The server reports `applied: true` even when it rewrites identical values, so that flag alone isn't trusted. |
| Auth and I18n context values rebuilt on every provider render, re-rendering every consumer (effectively the whole app) | Memoized (`useMemo`/`useCallback`) |

**Consent gates kept exact** (`useLegalConsentGate`, `useReceiptRequirements`, `ManagerDirectMessageModal`):
- They don't decide while a first-login signup sync is in flight (`signupSync.settled`).
- They re-check when the sync actually recorded a consent (`signupSync.generation`).
- Without this, a brand-new user could briefly be asked for consents they'd already given at signup, or be asked twice.

**Files.**
- New:
  - `src/lib/signupSync.ts`
  - `src/lib/authEvents.ts`
  - `src/lib/authStartup.test.ts`
- Edited:
  - `src/context/AuthContext.tsx`
  - `src/context/I18nContext.tsx`
  - `src/lib/signupOnboarding.ts` and `src/lib/consent.ts`: the sync helpers now return what they recorded. This is backward compatible, since the signup screens ignore the result.
  - `src/hooks/useLegalConsentGate.ts`, `src/hooks/useReceiptRequirements.ts`, `src/components/ManagerDirectMessageModal.tsx`

**Kept as is:**
- `refreshProfile()` still fetches the profile, and clears it on error, as before. The pending/disabled screens, profile save, change password, onboarding and the receipt gate all rely on it.
- The signup screens' own sync calls.
- Server enforcement: unchanged, and no database changes.

## Checks

| | Result |
|---|---|
| Jest | **749 passed**, 8 skipped (Step 1: 727). +22 tests: every auth event × same/different user; the 30 s resume throttle; the sync runs once, in order, reports what it recorded and never throws; profile-gap detection. |
| `tsc --noEmit` | clean |
| Lint | new files clean; edited files: identical warning counts to before, except `AuthContext.tsx` 1 → 1 (pre-existing) |
| **Auth/consent behaviour**, Step 1 build vs Step 2 build, isolated stack, Chromium **and** WebKit | **12 of 12 scenario runs identical** ([log](data/2026-10-15-phase1-step2-auth-consent-verification.log)): (1) normal sign-in, no gate; (2) legal gate genuinely required → shown, still shown after resume; (3) signup consents pending at first login → recorded exactly once each, **gate never flashed**, pending metadata cleared; (4) account switch → new user shown, no stale profile; (5) pending athlete approved while backgrounded → leaves `/pending` on resume; (6) athlete disabled while backgrounded → sent to `/disabled` on resume |
| Harness | Chromium 15/15 and WebKit 15/15 runs; dataset unchanged afterwards |

## Results [M-local] — median of 5 runs

Full tables, with baseline, Step 1 and Step 2 columns: [Chromium](data/2026-10-15-phase1-step2-vs-baseline-chromium.md), [WebKit](data/2026-10-15-phase1-step2-vs-baseline-webkit.md).

| Role | Metric | Baseline | Step 1 | **Step 2** | Δ vs baseline | Δ vs Step 1 |
|---|---|---|---|---|---|---|
| Athlete | **Cold start → content** (Chromium / WebKit) | 3,354 / 3,552 | 2,660 / 2,880 | **1,751 / 2,013 ms** | **−48% / −43%** | −34% / −30% |
| Coach | **Cold start → content** | 2,807 / 3,103 | 2,825 / 3,053 | **1,983 / 2,160 ms** | **−29% / −30%** | −30% / −29% |
| Manager | **Cold start → content** | 2,815 / 3,088 | 2,879 / 3,095 | **1,927 / 2,183 ms** | **−32% / −29%** | −33% / −29% |
| All | Home screen mounts at | 1,385–1,603 ms | 1,399–1,602 ms | **562–682 ms** | −57% to −63% | ≈ −60% |
| All | **Startup requests before the home mounts / sequential depth** | 6 / 6 | 6 / 6 | **2 / 2** | −4 / −4 | −4 / −4 |
| Athlete | All requests on cold start | 40 | 35 | **29** | −11 (−28%) | −6 |
| Coach | All requests on cold start | 42 | 42 | **37** | −5 (−12%) | −5 |
| Manager | All requests on cold start | 42 / 43 | 42 / 43 | **36 / 37** | −6 (−14%) | −6 |
| All | Profile reads on cold start (athlete / coach / manager) | 5 / 9 / 10 | 5 / 9 / 10 | **2 / 6 / 7** | −3 each | −3 each |
| All | Requests on resume (after 35 s in background) | 12 | 12 | **8** | −4 (−33%) | −4 |
| Athlete | Open session / back to home | | | unchanged from Step 1 | | within noise |

**What remains, and where it's addressed:**
- **Startup:** profile + session, plus the background sync (3 small requests, at most once per app session).
- **Resume (8 requests):** one throttled profile read plus 7 duplicated gate checks: consents ×3, address ×2, terms, direct message. → Phase 2 (shared gate state, resume handling).
- **Remaining coach/manager profile reads on cold start:** nav-badge counts per mounted header, staff birthdays. → Phase 2.

**Regressions:** none above noise.
- The only metric above +5% / +50 ms is **WebKit coach back-to-home skeleton time: +55 ms (+4%)** vs baseline (+24 ms vs Step 1). Chromium shows +23 ms for the same metric.
- The 5-run ranges overlap: baseline 1,455–1,512; Step 1 1,513–1,525; Step 2 1,483–1,571 ms.
- Step 2 runs no code during back-navigation.
- Classified as run-to-run noise, to watch. Step 5 removes these skeletons anyway.

## Real device

**[Pending device]** All numbers are local, with modelled latency. Cold-start improvement on your iPhone Home Screen PWA will be confirmed from your measurements once you collect them.

## Push synchronization (your decision, recorded for Phase 2)

Approved direction: keep the mechanism, but sync only when needed:
- at login;
- when the push permission changes;
- when the subscription or token changes;
- on relevant resume events;
- on expiry or invalidation.

No redundant syncs when nothing changed, and delivery must stay reliable. **Not part of Step 2.** The per-visit athlete-home re-sync is unchanged here.
