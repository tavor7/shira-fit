# Phase 0 — Performance baseline (2026-10-15)

Branch `perf/phase-0-baseline` (local, not pushed). Method, environments and metric definitions: [README.md](README.md).
Raw data: [data/](data/). Evidence labels: **[M-prod]**, **[M-local]**, **[E]**, **[Pending device]**.

## 1. Summary

- **Instrumentation is in the app and inert by default.**
  - Overhead when disabled is below measurement resolution.
  - Bundle cost is +2.8 KB gzip.
  - It is not deployed.
- **An isolated, production-shaped local environment and an automated harness exist.** They produced a reproducible baseline: 5 runs × 3 roles × 2 engines (Chromium and WebKit), all 30 runs successful.
- **The measurements confirm the audit's main diagnosis.** Latency comes from *round-trip count and ordering*, not from slow queries (except `manager_weekly_stats` global). The first screen cannot even start loading until a chain of 6 sequential requests finishes.
- **Real-iPhone numbers: not yet measured [Pending device].**

## 2. Production measurements [M-prod]

### Web app hosting (verified from the repository and live checks)

- **Production URL:** `https://shira-fit-mobile-web.onrender.com`.
  - Source: `EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN` in `mobile/.env`, plus `render.yaml`.
  - Its bundle references the production Supabase project.
  - `app.shirafit.com`, mentioned in `.env.example`, does not resolve.
- **Bundle:** one JS file, **1,025,862 bytes over the wire (brotli)**, 4.1 MB raw.
- **Caching:** `cache-control: public, max-age=0, s-maxage=300` on both the bundle and `index.html`. The browser must revalidate the bundle on **every** app start.
  - Measured from this Mac: 304 revalidation ≈ **0.27 s**; full download **0.70–1.70 s**.
  - The phone network was not measured [Pending device].

### API latency, 2026-10-14 (full UTC day, browser traffic only)

| | Value |
|---|---|
| REST/RPC requests (excluding preflights) | 4,725 from 39 distinct IPs; 1 × 4xx, 0 × 5xx |
| Edge→origin time | p50 **211 ms**, p90 525 ms, p95 586 ms |
| PostgREST time | p50 **7 ms**, p95 85 ms |
| `GET /auth/v1/user` (`supabase.auth.getUser()`) | **527/day**, p50 216 ms, p95 636 ms |
| Busiest endpoints | `profiles` GET 601 + HEAD 240; `training_sessions` 338 (p50 **402 ms**, the full-history payload); `get_required_consents` 260 (p50 464 ms); `get_my_subscription_terms` 290; `active_registration_counts` 223 |
| PostgREST service | 275 schema-reload notifications, 266 connection-pool re-initialisations, 658 "warp" timeouts per day (cause not attributed; audit H1) |

### Database (`EXPLAIN ANALYZE`, read-only transaction, regular manager, average of 3 runs)

| `manager_weekly_stats` | Production |
|---|---|
| global | **4,368 ms** (a 562 KB JSON result) |
| month | 321 ms |
| week | 163 ms |

`pg_stat_statements` snapshot: [data/2026-10-15-prod-pg_stat_statements.json](data/2026-10-15-prod-pg_stat_statements.json). Later snapshots are compared as differences; production stats are never reset.

### New risk confirmed: athlete calendar URL length (audit H5)

The athlete home sends every calendar session id in GET query strings (`session_registrations` / `waitlist_requests` `…&session_id=in.(…)`).

- **In production today:** median athlete **~8.9 KB** of query string; largest **~10.7 KB** (287 ids); 138 athletes above 7.4 KB. Production accepts these (no 414s in the logs).
- **Locally:** Kong rejected anything above ~8 KB with **414 URI Too Long**. The app's home then never finished loading. The harness raises the local limit so it can match production.
- **The production gateway limit is unknown** (Cloudflare/Supabase). Every athlete's list grows each week, because the browse range has no start date.
- **This is a correctness time bomb.** It should be removed in Phase 1; the planned change uses `eq(user_id)` instead of `in(ids)`.

## 3. Local baseline [M-local]

Isolated stack + latency proxy (190 ms per request), iPhone-sized viewport, median of 5 runs (p90 in the data files).

**Cold start excludes bundle download.** Add roughly 0.27 s (revalidation) to 0.7–1.7 s (first download) from the hosting measurement above.

**The local server is faster than production:** about 2–3.5× for `manager_weekly_stats`, so server-heavy steps are understated.

| Scenario | Metric | Athlete (Chromium / WebKit) | Coach | Manager |
|---|---|---|---|---|
| **S1 cold start** | content since navigation start | **3,354 / 3,552 ms** | 2,807 / 3,103 ms | 2,815 / 3,088 ms |
| | home screen mounts (focus) at | 1,554 ms | 1,420 ms | 1,385 ms |
| | shell requests before the home mounts / sequential depth | **6 / 6** | 6 / 6 | 6 / 6 |
| | home requests before content / depth | **34 / 7** | 35 / 6 | 36 / 6 |
| | all requests on cold start / response bytes (gzip) | 40 / 54 KB | 42 / 123 KB | 42 / 123 KB |
| **S2 open session detail** | tap → content | **1,317 / 1,470 ms** | 518 / 576 ms | 249 / 281 ms |
| | requests before content / depth | 8 / **6** | 10 / 3 | 6 / 2 |
| | requests in 5 s / settled | 11 / 2,060 ms | 19 / 1,461 ms | 6 / 420 ms |
| | roster content after focus | – | – | **1,264 / 1,431 ms** |
| **S3 back to home** | content already showing on arrival | yes | yes | yes |
| | **existing content hidden by a skeleton** | **1,752 / 1,876 ms** | 1,325 / 1,492 ms | 1,347 / 1,517 ms |
| | requests / depth / bytes | 20 / 7 / 49 KB | 17 / 7 / 116 KB | 18 / 7 / 116 KB |
| **S11 menu navigation** | Overview (dashboard, week) tap → content | | | 378 / 379 ms |
| | Sessions (home, new instance) tap → content | | | **1,494 / 1,546 ms**, 27 requests |
| **S9 dashboard** | → Month, click → content | | | 450 / 511 ms |
| | → Global, click → content | | | **1,704 / 1,923 ms**, 72 KB [production server ≈3× slower] |
| **S7 realtime** | one athlete registers while the manager home is open | | | **34 requests (≈235 KB) in 5 s**, 1 skeleton flash of **1,366 / 1,368 ms** |
| **S12 resume** | after 35 s in the background | **12 requests** | 12 | 12 |

Request counts and depths are identical in both engines, because the code paths are deterministic. WebKit timings run about 5–15% higher.

### What the requests are (Chromium run 1; counts per scenario)

- **Shell, before any screen mounts:** `profiles` → `sync_signup_profile_from_metadata` → `sync_signup_electronic_receipts_consent` → `sync_signup_legal_consents` → `profiles`. **Strictly sequential (C7).**
- **Athlete home, cold:**
  - **`auth:user` × 9 (C4)**;
  - `session_registrations` × 4, `waitlist_requests` × 2, `studio_calendar_notes` × 2;
  - `get_required_consents` × 3 and `get_address_collection_required` × 2 (C6);
  - the **second** profile-load chain (`profiles` + 3 sync RPCs; C7, the duplicate after `INITIAL_SESSION`);
  - `open_next_week_sessions_if_due` (C11).
- **Athlete back to home:** `auth:user` × 7, the full home reload (C1/C2).
- **Coach/manager home, cold:**
  - `profiles` × 6–7 (C5 nav badges per header, staff birthdays, profile reload);
  - `active_registration_counts` × 3, `session_notes` × 3, `studio_calendar_notes` × 2;
  - `maintain_session_series_horizon` + `open_next_week_sessions_if_due` (C11).
- **Coach session detail:** `session_billing_price_ils` × **6** (one per roster row; C8); `training_sessions` × 3, one of which is the full list for previous/next navigation (C15).
- **Manager session detail:** `profiles` × 3 (one nav-badge fetch per mounted header, C5).
- **Resume:**
  - `get_required_consents` × 3, `get_address_collection_required` × 2, `get_my_subscription_terms`, `get_pending_manager_direct_message`;
  - the **profile chain again**: `profiles` × 2 + 3 sync RPCs, triggered by the `SIGNED_IN` event that supabase-js fires on every return to a visible tab (C7).

### Not automated in this baseline (instrumented for manual measurement)

- Participant history: needs search-form driving.
- My sessions.
- Athlete register/cancel timing (S4).

These will be added to the harness before the Phase 1 steps that touch them.

## 4. Instrumentation verification

| Requirement | Evidence |
|---|---|
| Disabled by default | Enabled only on web, and only if `localStorage.sf_perf === "1"` on that device. Native builds never enable it. Jest: "is off by default". |
| No sensitive information | Records only endpoint labels from the existing `describeEndpoint` allowlist, method, status, timings, screen names and tap time. Jest asserts that ids, phone numbers, query strings and hosts never appear in a snapshot. Nothing is sent anywhere; bounded in-memory buffers. |
| Negligible overhead | Disabled fetch wrapper: **not measurable** (−170 ns vs. raw call, within noise). Disabled screen hook: **3 ns** per call. Enabled: 4.4 µs per request (≈0.002% of a 190 ms round trip). Bundle: **+8,374 B raw / +2,830 B gzip / +1,997 B brotli (+0.2–0.3%)**. |
| Transparent | The wrapper returns the same `Response` and rethrows the same error (Jest). It is the outermost layer, so the 401 refresh-and-retry is timed as one request, as the app experiences it. |
| Checks | Jest **723 passed** (8 skipped, unchanged); `tsc --noEmit` clean; no new lint warnings in any changed file (per-file before/after comparison); new files lint-clean. |

**Changed app files:**
- New: `mobile/src/lib/perf/{perfFlag,perfStore,perfAnalysis,requestTracker}.ts` and `perf.test.ts`, `mobile/src/hooks/usePerfScreen.ts`, `mobile/src/components/PerfPanel.tsx`.
- Edited: `mobile/src/lib/supabase.ts` (fetch wrapper), `mobile/app/_layout.tsx` (panel), and one `usePerfScreen(...)` line plus its import in 10 screens.

## 5. Limitations

- **No real-device data.** A real iPhone needs either the instrumentation deployed (inert; enabled only on your phone through Safari Web Inspector; read-only navigation), or a trusted certificate installed on the phone for the local stack.
- **The latency model is a constant 190 ms**, with no jitter, bandwidth limit or TLS setup. Bundle download is excluded from the local cold start. This Mac's CPU is faster than a phone's, so rendering cost is understated.
- **The synthetic dataset matches production's shape, with some differences:**
  - session series are not seeded;
  - documents, registration history, activity events and subscriptions are skipped;
  - the baseline athlete was chosen to match production's largest athlete-calendar list (285 vs 287 ids).
- **Dev-tooling hazard found:** building with `.env` present baked production's URL into `expo.extra`, which `supabase.ts` prefers, even when `EXPO_PUBLIC_SUPABASE_URL` was overridden. The harness requires `EXPO_NO_DOTENV=1` and `--clear`, and refuses bundles that reference any hosted project.
