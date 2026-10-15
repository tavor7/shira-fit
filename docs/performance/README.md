# Shira Fit — performance measurement

This folder holds the performance baseline and every before/after comparison for the optimization program.
Plan and findings: [2026-10-15-phase0-baseline.md](2026-10-15-phase0-baseline.md).

## Evidence labels (used in every report here)

- **[M-prod]**: measured on production, read-only (database statistics, `EXPLAIN ANALYZE` inside `BEGIN TRANSACTION READ ONLY`, Supabase logs, HTTP checks of the public web app).
- **[M-local]**: measured in the isolated local environment described below. These are real measurements of the app's code paths, but the network delay is **modelled**, not real.
- **[E]**: an estimate derived from the above.
- **[Pending device]**: a claim that still needs validation on a real iPhone Home Screen PWA. **No real-device improvement may be claimed until it has been measured there.**

## Environments

| Environment | What it is | Used for |
|---|---|---|
| Production (`vtngzvelcuagrfynzlfn`, web: https://shira-fit-mobile-web.onrender.com) | Live data and users | Read-only server-side measurements only. No test registrations, no writes. |
| **Isolated perf stack** (`shirafit-perf`, local Docker, API `127.0.0.1:57421`) | A separate local Supabase stack. All 302 migrations from the working tree (committed files plus the documented fresh-replay repairs in 4 old migrations). Synthetic data shaped like production (see `harness/seed/`). Cron jobs unscheduled so runs are repeatable. | Client measurements, including writes (S7 registers and cancels a synthetic athlete) |
| Preview stack (`supabase_*_sb`, `~/shira-fit-preview`) | Your nine-tasks QA preview | **Not used or modified** by the performance work |

### Isolated stack: setup (reproducible)

1. Create a working directory (outside the repo) containing `supabase/migrations` (a copy of the repo's migrations) and a `supabase/config.toml` with `project_id = "shirafit-perf"`.
   - Ports: api 57421, db 57422, shadow 57420.
   - Disabled services: studio, inbucket, analytics, edge runtime.
   - Then run `supabase start`.
2. `node harness/seed/create-perf-users.mjs` with `PERF_SUPABASE_URL=http://127.0.0.1:57421` and `PERF_SERVICE_ROLE_KEY` (from `supabase status -o env`). It creates 163 `@perf.test` accounts and refuses non-localhost URLs.
3. `docker exec -i supabase_db_shirafit-perf psql -U postgres -v ON_ERROR_STOP=1 -f - < harness/seed/seed-perf-dataset.sql`. It refuses any database that has users outside `@perf.test`.
4. Raise local Kong's header buffers to production-like limits:
   `docker exec -e KONG_NGINX_HTTP_LARGE_CLIENT_HEADER_BUFFERS="8 64k" supabase_kong_shirafit-perf kong reload`.
   Local Kong rejects query strings above ~8 KB with 414. Production accepts at least ~10.7 KB, because production athletes already send that much today.
5. Start the latency proxy:
   `PERF_TARGET=http://127.0.0.1:57421 PERF_PROXY_PORT=57499 PERF_LATENCY_MS=190 PERF_TLS_KEY=… PERF_TLS_CERT=… node harness/latency-proxy.mjs`
   It needs a self-signed certificate for 127.0.0.1. It serves HTTP/2 like production, so the browser is not capped at 6 connections, and gzips JSON.
6. Build the web app **against the proxy only**:
   `EXPO_NO_DOTENV=1 EXPO_PUBLIC_SUPABASE_URL=https://127.0.0.1:57499 EXPO_PUBLIC_SUPABASE_ANON_KEY=<local anon> npx expo export --platform web --clear --output-dir <dir>`
   - `EXPO_NO_DOTENV=1` and `--clear` are **mandatory**. Without them, `mobile/.env` and Metro's cache baked the production URL into `expo.extra` (observed 2026-10-15, caught before anything ran).
   - The runner refuses any bundle that references a hosted `*.supabase.co` project, and the browser aborts every request to `*.supabase.co`.
7. `node harness/serve-static.mjs <dir> 8199`: the same SPA rewrite and cache headers as production.
8. `node harness/run-scenarios.mjs` (env: `PLAYWRIGHT_MODULE_DIR`, `PERF_BUNDLE_DIR`, `PERF_OUT`, `PERF_ANON_KEY`, `PERF_ENGINE=chromium|webkit`, `PERF_RUNS=5`).

### Latency model

- **Measured in production [M-prod]:** a trivial request takes p50 ≈180–215 ms from the Cloudflare edge to the origin, while PostgREST answers in ~5 ms. Users are in Israel (TLV/HFA); the project is in Mumbai.
- **The proxy adds 190 ms per request.** That is about 180 ms edge→origin, plus an *assumed* ~10 ms phone→edge. Preflights get 20 ms, because production answers them at the edge.
- **The model is a constant:** no jitter, no bandwidth cap, no TLS handshake, no p95 tail. Results therefore show typical (median-like) waits and understate bad-network moments.

### Server speed calibration

The local database runs faster than the production Micro instance [M]:

| `manager_weekly_stats` mode | Local | Production |
|---|---|---|
| global | 1.41 s | 4.37 s |
| month | 142 ms | 321 ms |
| week | 45 ms | 163 ms |

So local timings for server-heavy steps understate production's server time by about 2–3.5×. Request counts and waterfall depth are unaffected.

## Instrumentation (app code)

`mobile/src/lib/perf/*`, `mobile/src/hooks/usePerfScreen.ts`, `mobile/src/components/PerfPanel.tsx`, plus one wrapper in `mobile/src/lib/supabase.ts`.

- **Off by default.** It is on only on web, and only when `localStorage.sf_perf === "1"` on that device: set it in the browser console or Safari Web Inspector, or open any app URL once with `?sf_perf=1` (`?sf_perf=0` turns it off). Native builds never enable it.
- **When off:** one cached boolean check per Supabase request and per instrumented screen render, and nothing else.
- **When on, it records only:**
  - an endpoint label from the existing `describeEndpoint` allowlist (e.g. `rpc:get_required_consents`, `rest:profiles`, `auth:user`);
  - the HTTP method and status;
  - timings;
  - screen names;
  - the time of the last tap.

  No URLs, ids, query strings, headers, bodies or user data. Data lives in bounded in-memory buffers and **nothing is sent anywhere**. It is read through the ⏱ panel ("Copy JSON") or `globalThis.__SF_PERF__.snapshot()`.
- **Instrumented screens:** `athlete.home`, `athlete.session`, `athlete.mySessions`, `coach.home`, `coach.session`, `manager.home`, `manager.session`, `session.roster`, `manager.dashboard`, `participantHistory`.

### Metric definitions

| Metric | Definition |
|---|---|
| **tap→content** | The user's tap (last `pointerdown`, at most 3 s before the screen gains focus) until the screen first shows its real content (not a skeleton or spinner). |
| **focus→content** | Screen focus until real content shows. **0** means content was already showing on arrival. |
| **content since navigation start** (cold start) | Page navigation start until the home screen's real content shows. Excludes downloading the JS bundle when served locally; see the bundle measurements. |
| **requests before content / depth before content** | Supabase requests started from focus until content. *Depth* is the longest chain of requests where each one started after another had already returned, i.e. the number of sequential round trips. It upper-bounds true data dependencies. |
| **requests / depth in 5 s; settled** | The same over the first 5 s after focus; *settled* = when the last of those requests returned. |
| **hidden after content** | Total time the screen replaced already-visible content with a loading state (skeleton flashes on refresh). |
| **startup requests** | Requests issued before the first screen visit: the app shell (auth, profile, consent and terms gates). |

## Real-device measurement (pending)

The iPhone Home Screen PWA cannot be measured against the isolated stack without installing a trusted certificate on the phone. Real-device numbers will come from production:
- with the instrumentation deployed (inert by default; this needs your approval);
- enabled on your phone only, through Safari Web Inspector (`localStorage.setItem('sf_perf','1')`);
- read-only navigation, with no registrations.

Until then every client number here is **[M-local]**, and any claimed improvement is **[Pending device]**.
