# Remote technical reporting pipeline (monitoring Phase 3E.3) - IMPLEMENTED, OFF

Client side of the reporting chain `classify -> eligibility -> payload -> flood control -> delivery -> breaker`. **It is disabled**:
`config.ts` holds `REMOTE_TECHNICAL_REPORTING_ENABLED = false` (a plain build-time constant, no env/storage/remote override), the server
switch `client_ingest_enabled` is false, and while the constant is false nothing is installed in any build, no deliverer exists and no
`report_client_error` request is ever made.

| Layer | File | Notes |
|---|---|---|
| A. classification | `rpcOutcomes/` (3A-3D), unchanged logic | the observer gained an optional `onOutcome` listener and `aggregate` switch: in production it keeps nothing |
| B. eligibility + C. payload | `eligibility.ts`, `allowlist.ts` | technical per the classifier AND an exact tuple of the server allowlist; fixed messages; `isValidWirePayload` mirrors the server validator |
| D. flood control, queue, breaker | `pipeline.ts` | in memory only |
| E. delivery | `delivery.ts` | `report_client_error` through the user's normal authenticated client; 5 s timeout |
| F. development aggregation | `rpcOutcomes/observer.ts` | unchanged, development only |

## Contract with the server (Phase 3E.2, 58 exact rules; `allowlist.ts` is checked against the migration by `remoteReporting.test.ts`)
`rpc/<rpc>` + `RpcOutcome` (registry technical code; HTTP 2xx `ok:false` or the P0001 RAISE token of a 4xx), `rpc/<rpc>` + `RpcReason`,
`rpc/postgrest` + `PostgrestError` + exact SQLSTATE/PGRST code (**the RPC name travels only in `context.rpc`**), `transport/infra` + `HttpError`
+ `http_502|503|504`, `transport/server` + `HttpError` + `http_500`. Payload fields: operation, error_class, error_code, message (fixed text),
severity (always `warning`), context (phase, rpc, sqlstate, http_status, retryable, table, edge_function), app_version, build, platform, env.

Not reported: business / authorization / uncertain / unknown outcomes, arbitrary SQLSTATE, arbitrary 4xx, 408/429, other 5xx, network
failures and offline, aborts, auth errors, the reporting RPC itself. Raw messages never take part in eligibility.

## Ownership (no duplicates)
Transport layer (3B): status 0, 5xx, 408, 429. RPC observer: 4xx except 408/429 and HTTP 2xx outcomes. Of those the pipeline accepts only the
approved 500/502/503/504 (transport) and the allowlisted technical outcomes. The same failure is also coalesced by key for 30 minutes.

## Flood control / breaker
30-minute coalescing per key; at most 5 per 10 minutes and 20 per hour; at most 10 pending; one in-flight delivery (5 s timeout);
no persistence, no retry queue. Server verdicts: `disabled`, `not_allowed`, `unauthenticated` and a 401/403 pause 6 hours (until the next sign-in
lifts it); quota/throttle verdicts pause for `retry_after_s` clamped to 1-60 minutes; `not_allowlisted`/`ignored`/`invalid_payload` suppress that key
for the session; `internal` and request failures back off 1, 2, 4... minutes, an hour after the third failure. Reports are delivered only while a
session exists (boolean tracked from `onAuthStateChange`; no user id, token or `getSession` per report); sign-out clears the queue.

## Known limitation
Because the server allowlist is exact, PostgREST/database errors are grouped per code under `rpc/postgrest` (one issue per code, not per RPC).
The RPC name is kept in the sampled events' `context.rpc` (5 events per issue per hour). Per-RPC fingerprints would need a server change.

Tests: `remoteReporting.test.ts` (50), `remoteReporting.mutation-checks.sh` (19 mutations), and the opt-in
`remoteReporting.local.integration.test.ts` (8 end-to-end checks against a local Supabase stack; skipped unless `SF_LOCAL_URL` is set).
