# Performance Phase 2 — application-wide audit (2026-10-31)

Branch `perf/phase2-app-wide` from `origin/main` 3bb5001. Evidence labels as in [README.md](README.md):
**[M-prod]** measured on production, read-only · **[M-local]** isolated perf stack (+190 ms modelled latency) · **[E]** estimate.

## 0. Baseline recovered

| Phase 1 item (deployed 2026-10-16, 6ef3350) | Still present on 3bb5001? |
|---|---|
| Step 1 local user id instead of `auth.getUser()` in hot paths | Yes (guard test still passes). Push-subscription syncs deliberately keep `getUser()` (see `currentUser.ts`). |
| Step 2 startup: 2 shell requests before first screen | Yes — startup shell requests = 3, depth 2 for every role [M-local]. |
| Step 3 home parallel loading | Yes on manager / coach / athlete homes. **Not applied to the roster calendar** (6 sequential awaits). |
| Step 4 detail parallel loading | Yes (roster depth 1-2). |
| Step 5 keep content during refresh | Yes on homes / roster; **roster calendar still flashed its loading state on every refocus.** |
| Steps 6 (register/cancel delays), 7 (bounded calendar), Phase 2 (shared nav / gates) | Not started — done in this phase (§2). |

Environment: the perf stack was rebuilt from all 368 current migrations (the old one predated 66 migrations), reseeded
with the Phase 0 data (846 sessions, 2,658 registrations, 163 users; production: 883 / 2,933 / 167) plus 60 subscriptions
created through `create_subscription` (production: 17). New harness: [run-screens.mjs](harness/run-screens.mjs) (real taps:
menu, tabs, rows, Back) for the screens Phase 0 never reached.

## 1. Performance map (confirmed findings, priority order)

| # | Affected | Root cause | Evidence | Status |
|---|---|---|---|---|
| F1 | Every staff action while another screen is open (attendance, payments, registrations by others) | Menu items `router.push`, so earlier screens stay mounted; the manager home's realtime channel (6 tables, unfiltered) reloaded each hidden home in full (all sessions + 3 count RPCs over every id + alerts) on every change anywhere | One attendance tap on Session Detail with two homes mounted: **60 requests** [M-local] | Fixed (P1-1) |
| F2 | Every navigation (manager) / athlete navigation | Pending-approval count and has-subscription check ran inside **each** mounted header's menu + the desktop rail, on every pathname change | `HEAD profiles` ×3-5 per manager navigation, growing with stack depth [M-local] | Fixed (P1-2) |
| F3 | App start and every resume | Legal-consent gate, receipt gate and manager-message modal each read `get_required_consents` / `get_address_collection_required` in the same commit | `get_required_consents` ×2 + address ×2 per start / resume [M-local]; `get_required_consents` is the 6th most frequent browser call (269/day, p50 414 ms at the edge although it executes in 5.8 ms) [M-prod] | Fixed (P1-3) |
| F4 | Staff homes, roster calendar (every visit, return, refresh, realtime reload) | Full-history `training_sessions` fetch and three count RPCs over every session id; grows ~35 sessions/week | `training_sessions` p50 513 ms vs ~220 ms floor; `visible_registration_counts` / `waitlist_counts` p50 ~520 ms [M-prod, 24 h]; 116-120 KB per staff home load [M-local] | Fixed (P3-1) |
| F5 | Session Detail (staff) | Previous/next bar downloaded the **whole** staff calendar on every open | 1 extra full-history request per detail open [M-local] | Fixed (P3-2) |
| F6 | Session Detail roster, every load and every attendance / payment change | One `session_billing_price_ils` RPC per participant | N requests per roster load (12 for a full session) | Fixed (P2-1, additive DB function) |
| F7 | Athlete register / cancel | Fixed animation wait (780 / 500 ms), then names and count requested one after the other | Code path; 2 sequential round trips after the animation | Fixed (P2-2) |
| F8 | Athlete home / calendar, every load | `sessions_select` RLS: `auth.uid()` per row inside an `EXISTS` over registrations prevents index use | **82 ms** of DB time per athlete calendar query, 73 ms in that sub-plan [M-prod EXPLAIN ANALYZE, read-only, approved athlete]; 34.5 ms → 3.9 ms with the init-plan form [M-local] | Fixed (P4-1, policy migration — needs your approval) |
| F9 | Every cold start of the web app / PWA | Content-hashed bundle served with `max-age=0`: revalidated on every launch | 304 in ~0.3 s before the app can run [M-prod curl] | Fixed (P5-1, render.yaml — needs blueprint sync) |
| F10 | Roster calendar | Never got Phase 1: 6 sequential awaits, loading state on every refocus | Code path | Fixed (P3-1) |
| F11 | Super user, manager home | `super_user_hidden_registrations?session_id=in.(every id)` → ~31 KB URL; the failure is swallowed as "nothing hidden" | Hidden marker missing on the perf stack (compare-ui A vs C); production likely affected (883 ids ≈ 33 KB), not confirmed (no super-user loads in the 24 h log window) | Fixed as a side effect of F4 |

## 2. Confirmed, not changed (need a decision or out of scope)

| # | Finding | Evidence | Why not changed |
|---|---|---|---|
| R1 | `manager_weekly_stats` (Overview / dashboard) | Production mean 584 ms, max 6.2 s; local week 113 ms, month 263 ms, global 1.65 s; global returns **600 KB** of JSON. ~13,000 calls of the per-row price function per 3 dashboard loads (SECURITY DEFINER + `set search_path` prevents inlining; several sections recompute the same prices) | Rewriting a financial aggregate (compute each price once in a CTE) or changing the price function's security properties needs your approval and a dedicated equivalence suite |
| R2 | Menu navigation pushes screens (stack grows, e.g. two manager homes) | F1, F2 measurements | Changing to `navigate` (pop back to an existing screen) changes Back behaviour — a UX decision. Its costs are neutralised by F1 / F2 |
| R3 | Roster reloads twice after the user's own attendance write (own refresh + realtime echo) | Attendance tap: 28 requests after F1 | Telling our own echo from someone else's change needs client/server clock comparison — not safe |
| R4 | Subscription-terms gate re-checks on every navigation + every 60 s | `get_my_subscription_terms` is the most-called RPC (298/day) [M-prod] | Documented as deliberate; server enforces anyway. Throttling to ~30 s is safe but changes documented behaviour |
| R5 | Athlete home re-runs push syncs (`auth.getUser()` ×2) on every focus | 2 requests per athlete home visit | Push-sync redesign was deferred by you; `getUser()` kept deliberately |
| R6 | `open_next_week_sessions_if_due` / `maintain_session_series_horizon` on every home focus | 1-2 requests per visit | Kept deliberately in Phase 1 Step 3 (registration opening on time if the cron is late) |
| R7 | Other RLS policies re-evaluating `auth.uid()` per row (85 more, advisor `auth_rls_initplan`) | Measured on 9 hot tables, 5 users: no material gain except `training_sessions`; `session_registrations` cost comes from per-row `is_registration_hidden*` helpers | No measurable benefit today; revisit as data grows |
| R8 | PostgREST schema-cache reloads ~100/day | `pg_timezone_names` 21,939 calls / 220 days [M-prod]; triggered by Supabase Realtime's partition maintenance (`ALTER TABLE realtime.messages_* OWNER`, ~280 times per partition) firing `pgrst_ddl_watch` | Platform-side; ~8 s DB time/day. Could be reported to Supabase |
| R9 | Single 4.3 MB (1.05 MB gzip) JS bundle, no route splitting | build output | Expo Router async routes on web are a large change with its own risks; F9 removes the per-launch revalidation |

## 3. Areas checked and found healthy

- Subscriptions list / detail, payments received, participant history: 2-3 parallel waves, small payloads (≤ 41 KB),
  276-526 ms tap→content [M-local]. Not worth changing.
- Startup shell: 3 requests, depth 2 for every role (Phase 1 holds).
- Session Detail (all roles): 265-318 ms tap→content, depth 1-2 (Phase 1 holds).
- Realtime on Session Detail is already filtered to the session.
