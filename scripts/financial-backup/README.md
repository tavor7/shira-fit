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

## PostgreSQL client version

`pg_dump`'s (and `psql`'s) client major version must be ≥ the server's (production is PostgreSQL
17) -- an older client dumping a newer server's schema is not a supported combination. The
workflow installs `postgresql-client-17` via the PGDG apt repo, but on `ubuntu-latest` that alone
is not enough: an older client is already earlier on `PATH` from the runner's own toolcache, so
bare `pg_dump`/`psql` keep resolving to it even after the newer package is installed (confirmed by
a real run: 17.11 was installed, but `pg_dump --version` in a later step still reported 16.15).
The install step now explicitly prepends `/usr/lib/postgresql/17/bin` to `$GITHUB_PATH` (so every
later step, including the npm scripts that spawn these tools by bare name, resolves the right
one) and asserts both `pg_dump --version` and `psql --version` report major version 17 by their
exact path -- not bare name -- failing the job immediately if they don't, rather than silently
running the wrong client. `PG_TOOLS_VIA_DOCKER=1` (local testing) is unaffected and needs no such
check: every tool there runs inside the pinned `postgres:17` image itself.

## Usage

```bash
npm install
# .env.local: FINANCIAL_BACKUP_SOURCE_URL=postgresql://...

PG_TOOLS_VIA_DOCKER=1 npm run dump     # omit PG_TOOLS_VIA_DOCKER if pg_dump 17+ is on PATH

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

**`verify.js` is a synthetic-fixture regression test, not a production verification tool.** It
asserts against *specific known values* from `test/seed-synthetic-data.sql` — `document_number =
'FINTEST-001'`, a reversed payment of exactly `90.00` ILS, a subscription freeze that must exist,
a negative `edit_correction` charge that must exist. Those assertions prove the dump/restore
*mechanism* works end-to-end against known data; they are meaningless against a real production
restore, which will never contain those exact rows and will correctly "fail" 6 of `verify.js`'s
17 checks for that reason alone (confirmed directly against this project's first production
backup — every one of those 6 failures matched live production's own actual counts exactly, see
`npm run verify-production` below). Keep using `npm run verify` for the synthetic regression
suite; use `npm run verify-production` for anything restored from a real backup.

## `verify-production.js` — production-data-agnostic verification

Checks structure, referential integrity, and invariants that hold regardless of what the actual
data is — never a specific row's value, a specific ID, or a specific fixture. Covers: required
schemas/tables exist, document-number uniqueness, FK integrity (documents↔customers,
document_events↔documents, PDF versions↔documents, charges↔billing periods, registrations↔
sessions, payments↔documents), cancellation history + its audit trail, the hard-delete guard
trigger, `list_documents()` executing, and a snapshot-time row-count comparison (below).

**The settings/consent audit pattern is handled explicitly, not by exemption.** A prior read-only
production audit found that `document_events` rows for `consent_declined`, `consent_accepted`,
`request_address_setting_changed`, `request_consent_setting_changed`, and
`operational_mode_changed` legitimately have no `document_id` — they reuse this table as a
settings/consent audit log, by design. `verify-production.js`'s check for this is: *every event
missing a document must have one of these five actions* — not "ignore events with no document."
If some other, unexpected action type ever shows up with a missing document reference, that is
flagged as genuine corruption, exactly as it should be. Proven both ways by
`test/negative-production-tests.js`: a corrupted `document_cancelled` event (not in the list) is
caught; a legitimately-inserted `consent_declined` event with no document is correctly not
flagged.

```bash
FINANCIAL_BACKUP_TARGET_URL=... FINANCIAL_BACKUP_RUN_DIR=out/<id> npm run verify-production
# or, restoring from R2:
FINANCIAL_BACKUP_TARGET_URL=... FINANCIAL_BACKUP_BACKUP_ID=<id> npm run verify-production
```

### Source/restore comparison: what it actually proves

`dump.js` now captures a row count for every table in `DATA_TABLES`, in the SAME `psql` session
that exported the snapshot (`PgSnapshotSession.query`, still inside that one `REPEATABLE READ`
transaction) — so the count is guaranteed consistent with the dump itself, never a separately-
timed count that could race a write landing between the dump and the count. These land in the
manifest as `data.table_counts` (manifest_version 2+). `verify-production.js` re-counts every
table in the restored database and compares it against this **snapshot-time** figure — deliberately
never against whatever the live production database looks like by the time someone gets around to
checking, which could legitimately have changed (new receipts, new payments) since the backup was
taken. A mismatch here means rows were lost or added somewhere in dump → upload → download →
restore — not that production has since received new data, which this check cannot see and does
not try to.

**What each verification layer actually guarantees — and what it doesn't:**

| Layer | Proves | Does NOT prove |
|---|---|---|
| SQL dump itself (`pg_dump` succeeding) | The source schema/data were readable and serializable at snapshot time | That every row's *content* is semantically correct (a value could be wrong but still dump fine) |
| SHA-256 artifact verification (upload-time `putAndVerify`, restore-time check, `verify-remote.js`) | The bytes in R2 are exactly the bytes produced by `pg_dump` — no corruption or tampering in transit/at rest | Anything about whether those bytes represent a *correct* backup of the source — a bug in the dump itself would still hash-match |
| Database restore succeeding (`psql` exit 0) | The SQL is syntactically valid and applied without a constraint violation | Nothing about completeness or correctness — a backup missing half its rows restores "successfully" too |
| `verify-production.js` structural/referential checks | The restored schema matches what the application expects, and every FK/invariant this project knows about actually holds in the restored data | Any invariant not explicitly checked here; a new relationship added to the schema later needs its own check added |
| Snapshot-count comparison | **Row-count completeness per table** — the restore has exactly as many rows per table as existed at snapshot time | **Row-level content parity** — two tables with the same count could still differ in which specific rows they contain, or in a column value within an otherwise-present row. This is NOT a content diff. |

No claim of complete row-level parity is made anywhere in this pipeline based on table counts
alone — row counts matching is evidence of completeness, not a guarantee of correctness for every
individual value.

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

**Workflow step ordering**: the GitHub Actions workflow runs `verify-remote.js` (independent
remote re-verification) *before* `health.js`, not after. Running them in the opposite order (the
original ordering) meant `health.js`'s `verification_is_stale` flag was always true immediately
after a brand-new backup — no verification record could exist yet — so every single successful
backup was reported as job-level `failure`, purely from that ordering, not from anything actually
wrong. Confirmed directly against this project's first production backup. The fix is `dump` →
`verify-remote` → `health`, so `health.js` always runs after the verification it's checking for
has had a chance to happen.

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
which every script that talks to Postgres already calls) forces `sslmode=verify-full` on every
real connection this tool makes — `check-connection.js`, `dump.js`, `restore.js`, `verify.js` —
unconditionally, overriding any weaker mode the connection string itself specifies. `verify-full`
is what actually proves something (server certificate chain AND hostname both validated, not
just "a TLS handshake happened").

`sslrootcert` points at `certs/supabase-root-2021-ca.pem` (bundled in this repo), NOT
`sslrootcert=system`. Supabase's Supavisor pooler terminates TLS with a certificate chain rooted
at Supabase's own private CA ("Supabase Root 2021 CA") — confirmed by probing the pooler's actual
certificate pre-authentication (no credentials needed: Postgres's SSL negotiation happens before
auth) and independently by `sslrootcert=system` failing with `SSL error: certificate verify
failed` against the real pooler. This CA is never present in any OS's default trust store, so
`system` can never work here — this is a public certificate (its only purpose is to be
distributed so clients can verify the server), checked into this repo for exactly that reason,
and independently verified with `openssl s_client -starttls postgres -CAfile
certs/supabase-root-2021-ca.pem -verify_hostname <pooler host>` returning `Verify return code: 0
(ok)`.

This enforcement is skipped ONLY when `PG_TOOLS_VIA_DOCKER=1` — that flag exclusively targets a
disposable local `postgres:17` Docker container with no TLS configured at all, used for local
development and CI-free testing against synthetic data (see "Usage" above). It never touches
Supabase, production, or real financial data, so forcing TLS there would make local testing
impossible without buying any real security.

## Production rollout procedure

Steps 1-6 below are **done** -- all GitHub Actions secrets are configured, `connection-check` and
real production `backup` runs have succeeded multiple times, `health`/`verify-remote` have run
against real production backups, and a real production backup has been restore-tested
end-to-end (structural + referential-integrity + snapshot-row-count checks, all passing). Step 7
(scheduling) is **implemented but not activated** -- see below.

1. ~~Add GitHub Actions secrets~~ — done (`FINANCIAL_BACKUP_SOURCE_URL`, `CF_ACCOUNT_ID`,
   `R2_ARCHIVE_*`, reused from the existing PDF archive — no new R2 credentials).
2. ~~Prove the secret is reachable~~ — done (`mode: connection-check`).
3. ~~First real production backup~~ — done, more than once.
4. ~~Verify uploaded objects~~ — done (`npm run health`).
5. ~~Restore test~~ — done, both as an explicit `mode: restore-test` dispatch and (once the
   `record-restore-test-result` job below lands) with its result durably recorded.
6. ~~First real verification record~~ — done (`npm run verify-remote`).
7. **Scheduling — implemented, gated off by default.** `.github/workflows/financial-backup.yml`
   now has four `schedule:` cron entries (two per trigger, one for each Israel DST season — see
   `src/scheduled-run-guard.js` for why a single UTC cron can't express "~03:00 Israel time" and
   why the guard is calendar-grain, never a strict wall-clock-hour check, since GitHub's own
   scheduled runs "may be delayed... or occasionally be skipped"). **Every scheduled firing is a
   no-op unless the repository variable `SCHEDULED_BACKUPS_ENABLED` is exactly `"true"`** —
   merging the workflow file does not, by itself, start anything. Setting that variable is the
   one explicit activation step, deliberately left for a separate, reviewed decision.
8. Monitoring/alerting for missed backups: `npm run health`'s non-zero exit code on
   `backup_is_stale`/`verification_is_stale`/`restore_test_is_stale`/incomplete already signals
   failure — see the Backup Management screen work (separate scope) for where this actually
   surfaces to a manager.

## Scheduling design (daily backup + weekly restore-test)

- **Daily backup**: crons `0 0 * * *` (Israel IDT season) and `0 1 * * *` (Israel IST season),
  both ~03:00 Israel local time depending on season. Each firing runs `scheduled-run-guard.js`
  (`GUARD_KIND=daily-backup`), which checks (a) is Israel's *actual current* UTC offset the one
  this cron entry was written for (skips otherwise — the other entry is the one that's "live"
  this half of the year), and (b) has a production backup already completed for *today's* Israel
  calendar date (skips otherwise — the idempotency net against overlap/retry/manual-run-same-day).
  Only if both say "proceed" does the real `npm run dump` (with `FINANCIAL_BACKUP_ENV=production`,
  `UPLOAD_TO_R2=1`) run, followed by `verify-remote` and `health`, exactly like a manual
  `mode: backup` run.
- **Weekly restore-test**: crons `0 2 * * 0` / `0 3 * * 0` (Sundays, same DST-season split). Guard
  kind `weekly-restore-test` checks the DST season the same way, plus "has a restore-test run in
  roughly the last 6 days" (rolling window, not an ISO-week boundary). The backup to test is
  **never** a fixed/manual `backup_id` for a scheduled run — `select-latest-verified-backup.js`
  picks the newest production backup that already has a successful `verify-remote` record,
  falling back to an older one if the newest hasn't been remotely verified yet for some reason.
- **Overlap/duplicate protection**: the idempotency checks above are the primary guard (a
  same-day/same-week duplicate correctly no-ops); additionally, GitHub Actions itself serializes
  `schedule` events for the same workflow (a new scheduled run is skipped if a prior run of the
  same workflow is still in progress past a platform-defined queue limit) — see GitHub's own
  documented scheduled-workflow behavior.
- **Result persistence**: daily backups already persist to R2 via the existing manifest/
  verification-record mechanism. Restore-tests now also persist one immutable record per run
  (`db-backups/restore-tests/<backup_id>-<timestamp>.json`, via `write-restore-test-result.js`),
  written by a dedicated `record-restore-test-result` job that `needs: restore-test` and does
  nothing else — deliberately kept separate so the R2 **writer** credential this needs is never
  granted to the `restore-test` job itself (which downloads and restores real backup content into
  an ephemeral target). `health.js` reads these records to report `last_restore_test` and
  `newest_backup_restore_tested` (specifically whether the *current newest* backup — not just
  *some* backup — has a passing restore-test on record).

## Not yet done (needs separate approval or further work)

- **Setting `SCHEDULED_BACKUPS_ENABLED=true`** — the one remaining activation step for everything
  in "Scheduling design" above.
- The manager-only Backup Management screen, receipt-archive health reporting, and the
  accounting-document export feature (UI + new backend APIs, separate, larger scope — see the
  project's Backup Management implementation plan).
