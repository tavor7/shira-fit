# Client technical reporting foundation (monitoring Phase 3B)

Makes the client reporting architecture real and testable **without enabling ingestion**: nothing here sends anything.
`client_ingest_enabled` stays `false`, no deliverer is installed, no production monitoring row can be created by this code.

| File | Role |
|---|---|
| `reporter.ts` | `reportTechnicalError(input)` / `TechnicalReporter`: normalize, sanitize, coalesce, cap, observe (dev only), deliver (only if a deliverer is installed) |
| `transportCapture.ts` | `withTransportCapture(fetch, {supabaseUrl})`: transport-level capture installed around the Supabase client's fetch |
| `sanitize.ts` | Minimal client-side sanitization + strict context allowlist |
| `buildInfo.ts` | App version / native build / platform / env from the Expo runtime |
| `types.ts` | Report shapes (mirror the Phase 1 untrusted-client contract) |

## Ownership boundary (to avoid duplicate reports)

* **Phase 3B (this code): TRANSPORT** - fetch rejections and unambiguous non-2xx HTTP responses.
* **Phase 3C (not started): RPC OUTCOMES** - HTTP-2xx `{ok:false,...}` results classified through the Phase 3A registry
  (`src/lib/rpcOutcomes`). The transport layer **never reads, clones or parses any response body** (tested), so the two
  layers cannot see the same failure.

## Network-path audit (Phase 3B, supabase-js 2.112.2)

`authAwareFetch` is still the right common point: it is passed as `global.fetch`, and supabase-js uses it for **every**
HTTP client it builds. `withTransportCapture(authAwareFetch)` is installed as the outermost layer, so a request recovered
by the 401 refresh-and-retry is judged on its final outcome.

| Path | Goes through `global.fetch`? |
|---|---|
| `supabase.rpc(...)`, `.from(...)` reads/writes (PostgREST) | yes |
| `supabase.auth.*` (token, signup, user, recover, ...) | yes (`settings.global.fetch` is handed to the auth client) |
| `supabase.functions.invoke(...)` (8 call sites, Edge Functions) | yes |
| `supabase.storage.*` (4 call sites, signed URLs / remove) | yes |
| `authAwareFetch`'s own `auth.refreshSession()` | yes (it re-enters through the wrapped client) |
| Direct application `fetch(...)` | **none exist** (grep over `src/` and `app/`) |
| Realtime / Presence (`supabase.channel`, 3 sites) | **no** - WebSocket, not fetch |
| Expo push-token registration, `Linking.openURL`, `window.open`, image loading, Expo updates | **no** - platform APIs, not Supabase fetch |

Not expanded in this phase: WebSocket/realtime failures and platform network APIs have no capture.

## What is reported at the transport layer, and what is deliberately deferred

Evidence: PostgREST maps `RAISE EXCEPTION` business tokens to HTTP 400, unique/FK conflicts to 409, `.single()` misses
to 406; Supabase Auth returns 400/401/422/429 for normal states (wrong password, refresh-token rejection, signup
validation, rate limits); this repo's Edge Functions return 400/401/403/404/405/409 deliberately and 500/595 for real failures.

| Class | Reported? |
|---|---|
| fetch rejection (offline, DNS, TLS, reset) | yes, `info`, `retryable` (AbortError = cancellation: never) |
| any 5xx on rest / rpc / auth / storage / functions | yes (`502/503/504` = `warning` + retryable, other 5xx = `error`) |
| 408 / 429 on rest, rpc, storage, functions | yes, `warning`, retryable |
| every other 4xx (all families), incl. auth 400/401/422/429, rest 400/401/403/404/406/409, functions 4xx | **no - deferred** to caller-level / Phase 3C integration (needs body or call-site knowledge) |
| 2xx (including `{ok:false}` bodies) | no |
| requests to other hosts, unknown Supabase paths, the monitoring report RPC itself | no |

## Safety properties

* `reportTechnicalError` never throws and returns nothing; every capture step in the fetch wrapper is inside `try/catch`;
  the wrapper returns the **same Response object** or rethrows the **same error object**.
* No UI, toast, alert, navigation, auth access, console output, storage or persistence.
* Recursion: the report RPC path (`/rest/v1/rpc/report_client_error`) is excluded by exact path (stateless, deterministic),
  and a re-entrancy guard drops reports raised synchronously from inside a delivery attempt.
* Flood control: identical reports inside 60 s are coalesced (count only), at most 30 new reports per window, 100 tracked
  keys, 50 observed entries, no retries, no queue, nothing persisted. Dropping a report is acceptable.
* Observation sink: in-memory ring buffer, active only when `__DEV__` is true (inert in production builds). It exists only
  to prove what *would* be reported.
* Sanitization: input bounded to 2000 chars **before** any regex runs (a multi-megabyte message cannot cost quadratic
  time), tokens/JWTs/Bearer/`key=value` secrets/URLs/emails/UUIDs/timestamps/long digits replaced, message bounded to 200.
  Context is a strict allowlist (`http_status`, `rpc`, `table`, `edge_function`, `network_state`, `phase`, `retryable`,
  `attempt`, `duration_ms`) with per-key type validation; everything else (ids, headers, bodies, free text) is dropped.
  The server remains authoritative for redaction and fingerprinting.

## Build / version metadata (`buildInfo.ts`)

`appVersion` = `expoConfig.version` (app.json, currently 1.0.0), `build` = native build number / version code, `platform` =
`ios|android|web`, `env` = `dev | prod | expogo`. Nothing is invented; unavailable fields are omitted.
Differences: **production native build** - version + native build; **development build** - same, `env=dev`;
**Expo Go** - the project's version but Expo Go's own native build, `env=expogo`; **web** - version only, no native build.
`app.json` defines no `ios.buildNumber`/`android.versionCode`; EAS supplies them for store builds.

## Follow-ups (not in this phase)

* **Phase 3C:** RPC outcome layer using `classifyRpcOutcome`; deliverer through `report_client_error` (then flip
  `client_ingest_enabled`); resolving the deferred 4xx categories with body/caller knowledge (e.g. PostgREST `PGRST202`
  404 = missing function, 5xx-class SQLSTATEs).
* **Global crash handling (later):** `AppErrorBoundary.componentDidCatch` (render errors; today DEV-logging only),
  React Native `ErrorUtils.setGlobalHandler`, web `window` `error`/`unhandledrejection`. Each is a one-line
  `reportTechnicalError` call once agreed; deliberately not wired now.
* Realtime/WebSocket failures have no capture.
