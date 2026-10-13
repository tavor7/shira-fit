/**
 * Build-time gate for REMOTE technical reporting (monitoring Phase 3E.3).
 *
 * FALSE in the repository and therefore in every build. While it is false:
 *   - nothing is installed in a production build (no RPC observer, no auth listener, no deliverer),
 *   - no request to report_client_error is ever made,
 *   - the pipeline's `submit` returns before doing any work.
 *
 * Turning reporting on is a separate, reviewed code change (Phase 3E.4+), and the server switch client_ingest_enabled must also be on.
 * There is deliberately NO environment variable, query string, storage key or remote-config override: tests enable the pipeline only by
 * constructing their own instance with an injected `enabled` function, never through this constant.
 */
export const REMOTE_TECHNICAL_REPORTING_ENABLED: boolean = false;
