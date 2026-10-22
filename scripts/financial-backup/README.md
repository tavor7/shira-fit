# Financial backup & recovery tooling

Schema + scoped financial-data backup, with a proven restore procedure. Backups are stored
**unencrypted** in a private Cloudflare R2 bucket — see "Encryption" below for why, and what
protects the data instead. **Not wired to a production schedule yet** — see
`.github/workflows/financial-backup.yml` (manual trigger only).

## What's backed up

See `src/scope.js` (single source of truth):
- **Schema** (`--schema-only`): the full `public` + `archive` schemas. Cheap (DDL only), and this
  is what makes restore actually work — see "Real dependencies found" below for why a scoped
  data-only dump cannot stand on its own.
- **Data** (`--data-only`, `--disable-triggers`): the financial-domain tables plus the
  non-financial context tables their own triggers/FKs require at restore time (`profiles`,
  `manual_participants`, `training_sessions`) — confirmed necessary by reading the actual trigger
  function bodies, not assumed.

Both are produced together, in one run, under one `backup_id` — never on separate schedules, so a
data snapshot can never be paired with an incompatible schema snapshot.

## Real dependencies found while proving this (not assumed)

Restoring the schema dump into a genuinely clean, non-Supabase `postgres:17` container failed
four times before succeeding, each time on a real, confirmed dependency:

1. **`profiles.user_id` has a real FK to `auth.users`.** Supabase's `auth` schema is deliberately
   excluded from the backup (it's platform-managed, not financial data) — a restore target needs
   either a real Supabase-provisioned Postgres (which already has it) or the minimal stub in
   `test/supabase-compat-stub.sql`.
2. **Several receipt RPCs call `auth.uid()`** (`cancel_document`, `create_document`, ...) — a
   GoTrue-specific function with no stock-Postgres equivalent. Stubbed the same way this repo's
   own SQL test suite already does locally.
3. **One `public` view (`system_monitoring_observer_health`, unrelated system-monitoring code)
   joins against `cron.job`/`cron.job_run_details`** — pg_cron isn't installed in a stock Postgres
   image. Minimal table stubs, confirmed by reading the view's actual definition.
4. **Several GiST indexes on `uuid` columns require the `btree_gist` extension** — a real
   prerequisite (needed on any restore target, Supabase or not), not a stub. Install it into its
   own `extensions` schema (matching Supabase's own convention) so it survives a
   `DROP SCHEMA public CASCADE` during restore prep, and set
   `search_path = public, extensions` on the target database.
5. **GRANT statements throughout the dump target the `anon`/`authenticated`/`service_role`
   database roles** — platform-managed roles, not schema objects, absent on stock Postgres.

All five are captured in `test/supabase-compat-stub.sql` (roles, GiST extension, `cron.*`
stub) plus `auth.users`/`auth.uid()` — with a clear comment on each explaining exactly why it's
needed and citing the real object that required it. **None of this is needed when restoring into
an actual Supabase-provisioned Postgres** (new project or existing installation) — only for
testing recoverability independent of Supabase.

## Usage

```bash
npm install
# .env.local: FINANCIAL_BACKUP_SOURCE_URL=postgresql://...

PG_TOOLS_VIA_DOCKER=1 npm run dump     # omit PG_TOOLS_VIA_DOCKER if pg_dump is on PATH

# Restore test (clean target):
#   1. docker run -d -e POSTGRES_PASSWORD=postgres -p 55499:5432 postgres:17
#   2. create extension btree_gist, apply test/supabase-compat-stub.sql, drop+recreate public
#   3. FINANCIAL_BACKUP_RUN_DIR=out/<id> FINANCIAL_BACKUP_TARGET_URL=... npm run restore
#   4. FINANCIAL_BACKUP_TARGET_URL=... npm run verify
```

Restoring a **legacy** (pre-simplification) encrypted backup additionally requires the original
KEK: `FINANCIAL_BACKUP_TEST_KEK=<base64 key> FINANCIAL_BACKUP_RUN_DIR=out/<id> FINANCIAL_BACKUP_TARGET_URL=... npm run restore`.
`restore.js` reads `manifest.json`'s `encryption.algorithm` to decide which code path to take —
you don't need to tell it which format it is.

## What `verify.js` actually checks

Not "did `psql` exit 0" — real queries against the restored copy: FK integrity (documents↔
customers, document_events↔documents), document numbering uniqueness, payment-relationship
integrity, subscription billing chain integrity, cancellation history + its audit trail, PDF
archive version-1 path consistency, that the hard-delete guard trigger is still present and
active, and that `list_documents()` actually executes against the restored data.

## Encryption

**Decision: no application-managed encryption key.** Backups are stored as plain SQL text in the
private R2 bucket. This was a deliberate simplification, not an oversight: application-level
envelope encryption (AES-256-GCM, Phase 1-3 of this project) added real operational burden — a
production KEK with its own offline-custody procedure, rotation story, and a way for a backup to
become permanently unrestorable if that key were ever lost — without changing the actual threat
model, because the bucket, credentials, and transport were already protecting the same data. The
owner chose to drop it and rely entirely on:

- **R2 provider-managed encryption at rest** — Cloudflare encrypts all object data at rest by
  default; this requires no key management on our side at all.
- **Private bucket access** — the bucket has no public access and no public object URLs; every
  read/write requires one of the scoped R2 credentials below.
- **TLS in transit** — every `pg_dump`/R2 request already runs over HTTPS/TLS; nothing here was
  stored or sent in the clear even under the old design.
- **Least-privilege, scoped credentials** — the existing writer/reader R2 API tokens, scoped to
  this one bucket, reused from the PDF archive (see "R2 integration" below) — no new credential,
  no broader scope than before.
- **Integrity, independent of encryption** — SHA-256 of each artifact is recorded in the manifest
  at backup time and re-checked at restore time and by `verify-remote.js`; this catches corruption
  or tampering exactly as reliably as the AES-GCM auth tag did, just without needing a key to do
  it.

**What this trades away**: previously, someone with read access to the R2 bucket but without the
KEK could not read backup contents (defense in depth against a compromised reader credential or a
misconfigured bucket). Under the new model, R2 bucket access alone is sufficient to read backup
contents — access control is entirely the bucket's privacy + the credential scope, not a second
independent secret. The owner's call: this is an acceptable trade for the simplification.

**Legacy backups**: Phase 1-3 of this project produced AES-256-GCM-encrypted backups. Those
remain restorable — `restore.js` reads the manifest's `encryption.algorithm` and takes the
decrypt path automatically when it finds `"aes-256-gcm-envelope"` instead of `"none"`. `src/
generate-kek.js` still exists, but only to regenerate/exercise that legacy path (e.g. a disposable
test key for the compatibility test); it is not part of the normal backup/restore flow anymore.

## Consistency guarantee (Phase 2)

The schema dump and data dump are two separate `pg_dump` processes, but both attach to the
**same exported Postgres snapshot** (`PgSnapshotSession` in `pg-exec.js`: one long-lived `psql`
session opens a `REPEATABLE READ` transaction, calls `pg_export_snapshot()`, and stays open for
the duration of both dumps, each invoked with `--snapshot=<id>`). **Guarantee**: the data dump
can never reflect a write that happened after the schema dump started, or vice versa — both see
the database exactly as it was at one instant. **Limitation**: this only guarantees that *this
run's* schema and data are mutually consistent — it says nothing about whether an operator later
mixes artifacts from two different `backup_id`s. That specific mistake is caught separately: the
data artifact embeds the SHA-256 of its paired schema dump, and `restore.js` refuses to proceed if
the schema it's about to apply doesn't match.

## R2 integration (Phase 2)

Reuses the existing `shirafit-receipt-archive` bucket and its writer/reader credentials — no new
bucket, no new credentials — under `db-backups/{schema,data,manifests}/<backup_id>.*`. Current
backups are stored as raw SQL under `<backup_id>.sql`; legacy encrypted backups remain under
`<backup_id>.sql.enc.json` (both prefixes are still read by `restore.js`/`health.js`, selected by
the manifest's format marker). Every upload is independently re-read with the reader credential
and SHA-256-compared before being considered successful (never trusts a 200 status or ETag
alone), retried 3x with backoff on transient failure, and refuses outright if the target key
already exists. See `src/r2.js`. The bucket itself remains private (no public access, no public
object URLs) and is accessed only over HTTPS/TLS with these same scoped credentials — see
"Encryption" above.

## Monitoring (Phase 2)

`src/health.js` lists the manifests in `db-backups/manifests/` and, for each, independently
confirms the paired schema+data objects actually exist before counting it as complete — a backup
can have a manifest and still be reported incomplete if either artifact is missing. No new
Postgres table was added (none is authorized yet); the manifests in R2 **are** the durable run
records. Only manifests with `source.label === "production"` count toward the health metrics —
test/dry-run backups remain in R2 forever (Bucket Lock) but are excluded from the aggregate.

## Format identification (formerly "Key identification", Phase 3)

Every manifest carries an explicit `encryption.algorithm` field: `"none"` for the current
(unencrypted) format, or `"aes-256-gcm-envelope"` for a legacy Phase 1-3 backup — plus, only for
the legacy format, a non-secret `encryption.kek_id` label (e.g. `"prod-2026-10"`) identifying
which key was used, never the key itself. `restore.js` and `verify-remote.js` both read this
field first and branch accordingly — nothing about restoring a backup requires the operator to
know in advance which format it's in. For a legacy backup, the same fail-fast label check as
before still applies: a mismatched `FINANCIAL_BACKUP_TEST_KEK_ID` is rejected before decryption is
even attempted, with the AES-GCM auth tag as the actual cryptographic backstop.

## Stale backup detection (Phase 3)

`health.js` now distinguishes two different questions: "is the most recent backup well-formed"
(Phase 2) and "did a production backup actually happen recently" (Phase 3 — this is what catches
a scheduled job that silently stopped running). `backup_is_stale` is true if the last successful
*production* backup is older than `FINANCIAL_BACKUP_STALE_THRESHOLD_HOURS` (default **36**) or if
no production backup has ever completed. `verification_is_stale` is the same check against
`src/verify-remote.js`'s independent re-verification records (`db-backups/verifications/` — a
new immutable record per check, not a mutable field, consistent with everything else in this
archive). `health_status` is only `"healthy"` when nothing is incomplete, stale, or unverified —
never derived solely from the shape of the latest manifest. No new Postgres table was added for
this either.

## Test/production isolation (Phase 3)

- `source.label` is set by exactly one switch, `FINANCIAL_BACKUP_ENV=production` — every other
  case defaults to `"test"`, so a run can only become "production" by deliberate, explicit opt-in,
  never by omission. (Phase 2's logic incorrectly tied this label to whether R2 upload happened,
  which is a different question — fixed in this phase.)
- `health.js` and `verify-remote.js` both filter on `source.label === "production"` before
  touching anything else — a test backup can never contribute to a health metric, and a
  verification record for a test backup is ignored even if it exists.
- Every artifact already uploaded during Phase 1/2 testing remains labeled `"test-upload"` /
  `"local-test"` (the pre-fix values) and is correctly excluded under the new filter too —
  confirmed by running `health.js` against the real bucket right now: `total_backups: 0`, because
  no production backup has ever actually happened yet. **No existing R2 object needed deleting**,
  and none was deleted — Bucket Lock wouldn't allow it even if desired.
- A future accounting export, built later, should apply the identical `source.label ===
  "production"` filter — noted here so that code inherits this isolation rather than
  re-discovering it.

## Legacy KEK procedure (only relevant for a Phase 1-3 encrypted backup)

There is no production KEK to generate or store for the current backup format — see
"Encryption" above. `src/generate-kek.js` and `FINANCIAL_BACKUP_TEST_KEK`/
`FINANCIAL_BACKUP_TEST_KEK_ID` still exist solely to restore a legacy encrypted backup that
predates this change, or to generate a disposable key for exercising that code path in a test
(see `test/make-legacy-fixture.js`). If you still hold a real legacy production KEK from before
this change, keep it in secure offline custody until you're confident no legacy backup will ever
need restoring again — do not add it back to GitHub Actions secrets, since the workflow no longer
reads or needs it.

## Connection-only check

`src/check-connection.js` (`npm run check-connection`) does exactly one thing: `SELECT 1` against
`FINANCIAL_BACKUP_SOURCE_URL`, nothing else — no `pg_dump`, no R2 touch, no financial data read.
In the workflow, pick `mode: connection-check` on a manual run to exercise only this step — use it
to prove a new or rotated `FINANCIAL_BACKUP_SOURCE_URL` is reachable before ever pointing a real
backup at it. Running a full backup is not a substitute for this: a backup, even a dry run, reads
the entire financial dataset, where this check reads nothing.

## TLS enforcement (applies to every real connection, not just the check above)

`src/pg-exec.js`'s `withEnforcedTls` (applied automatically inside `dockerizeConnectionString`,
which every script that talks to Postgres already calls) forces `sslmode=verify-full` AND
`sslrootcert=system` on every real connection this tool makes — `check-connection.js`, `dump.js`,
`restore.js`, `verify.js` — unconditionally, overriding any weaker mode the connection string
itself specifies. `verify-full` is what actually proves something (server certificate chain AND
hostname both validated, not just "a TLS handshake happened"); `sslrootcert=system` tells libpq to
validate against the OS's own trusted CA store instead of the default `~/.postgresql/root.crt`,
which doesn't exist on a fresh GitHub Actions runner — this supplies the trust anchor
`verify-full` needs to run at all, it does not relax verification. Supported by libpq 16+ (added
upstream in PostgreSQL 16); confirmed present in the `postgresql-client-17` package this workflow
installs.

This enforcement is skipped ONLY when `PG_TOOLS_VIA_DOCKER=1` — that flag exclusively targets a
disposable local `postgres:17` Docker container with no TLS configured at all, used for local
development and CI-free testing against synthetic data (see "Usage" above). It never touches
Supabase, production, or real financial data, so forcing TLS there would make local testing
impossible without buying any real security.

## Production rollout procedure (prepared, NOT executed)

1. Add GitHub Actions secrets: `FINANCIAL_BACKUP_SOURCE_URL` (Supavisor **session pooler**
   connection string — confirmed the correct mode, see Phase 1 research). Reuse the existing
   `CF_ACCOUNT_ID`/`R2_ARCHIVE_*` secrets (already configured for the PDF archive) — no new R2
   credentials, and no encryption key to generate or store.
2. Run the workflow once with `mode: connection-check` to prove the secret is reachable (`SELECT
   1` only) before doing anything else with it.
3. First manual run: trigger the workflow by hand (`workflow_dispatch`) with `mode: backup`,
   `FINANCIAL_BACKUP_ENV=production` and `upload_to_r2: true`.
4. Independently verify the uploaded objects: run `npm run health` (reader credential only) and
   confirm `complete_backups: 1`, `incomplete_backups: 0`.
5. Restore test: run `npm run restore` with `FINANCIAL_BACKUP_BACKUP_ID` set to that backup,
   targeting a fresh, isolated scratch Postgres (never production) — exactly the procedure
   already proven in testing, now against the real production backup. Run `npm run verify` (or
   the project's own financial regression checks) against the restored copy.
6. Only after step 5 succeeds: run `npm run verify-remote` once by hand to produce the first real
   verification record, then confirm `npm run health` shows `verification_is_stale: false`.
7. Only after steps 2-6 have all succeeded at least once: add the `schedule:` trigger to
   `.github/workflows/financial-backup.yml` (currently absent by design) for the daily cadence,
   and a second scheduled invocation of `verify-remote.js`.
8. Monitoring/alerting for missed backups: wire a scheduled `npm run health` check (its non-zero
   exit code on `backup_is_stale`/`verification_is_stale`/incomplete already signals failure) into
   whatever alerting channel is appropriate — no new mechanism needed, the signal already exists.

## Not yet done (needs separate approval)

- Executing the rollout procedure above.
- Enabling the GitHub Actions `schedule:` trigger (currently `workflow_dispatch` only).
- Running a real backup against production data (everything proven so far uses synthetic data
  only, per instruction).
- The manager-only Backup Management screen and filtered accounting exports (UI, separate scope).
