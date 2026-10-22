# Financial backup & recovery tooling (Phase 1 — local only)

Schema + scoped financial-data backup, AES-256-GCM envelope encrypted, with a proven restore
procedure. **Not wired to production, R2, or a schedule yet** — see
`.github/workflows/financial-backup.yml` (manual trigger only, upload disabled).

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
node src/generate-kek.js        # prints a disposable key for THIS test run only
# paste it into .env.local as FINANCIAL_BACKUP_TEST_KEK=

# .env.local: FINANCIAL_BACKUP_SOURCE_URL=postgresql://...

PG_TOOLS_VIA_DOCKER=1 npm run dump     # omit PG_TOOLS_VIA_DOCKER if pg_dump is on PATH

# Restore test (clean target):
#   1. docker run -d -e POSTGRES_PASSWORD=postgres -p 55499:5432 postgres:17
#   2. create extension btree_gist, apply test/supabase-compat-stub.sql, drop+recreate public
#   3. FINANCIAL_BACKUP_RUN_DIR=out/<id> FINANCIAL_BACKUP_TARGET_URL=... npm run restore
#   4. FINANCIAL_BACKUP_TARGET_URL=... npm run verify
```

## What `verify.js` actually checks

Not "did `psql` exit 0" — real queries against the restored copy: FK integrity (documents↔
customers, document_events↔documents), document numbering uniqueness, payment-relationship
integrity, subscription billing chain integrity, cancellation history + its audit trail, PDF
archive version-1 path consistency, that the hard-delete guard trigger is still present and
active, and that `list_documents()` actually executes against the restored data.

## Encryption

AES-256-GCM envelope (native Node `crypto`, no new dependency): a fresh random DEK per backup,
wrapped by a long-lived KEK. The KEK is never written to this backup's artifacts. See
`src/generate-kek.js` for the generation procedure — **do not use a key it prints as a real
production key without a separate, explicit decision about offline custody.**

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
bucket, no new credentials — under `db-backups/{schema,data,manifests}/<backup_id>.*`. Every
upload is independently re-read with the reader credential and SHA-256-compared before being
considered successful (never trusts a 200 status or ETag alone), retried 3x with backoff on
transient failure, and refuses outright if the target key already exists. See `src/r2.js`.

## Monitoring (Phase 2)

`src/health.js` lists the manifests in `db-backups/manifests/` and, for each, independently
confirms the paired schema+data objects actually exist before counting it as complete — a backup
can have a manifest and still be reported incomplete if either artifact is missing. No new
Postgres table was added (none is authorized yet); the manifests in R2 **are** the durable run
records. Only manifests with `source.label === "production"` count toward the health metrics —
test/dry-run backups remain in R2 forever (Bucket Lock) but are excluded from the aggregate.

## Production KEK setup procedure (not automated — do this yourself)

1. Run `node src/generate-kek.js` on a machine you trust, **once**, for the real production key
   (not the disposable test key used above).
2. Store copy #1 in the production secret store (`FINANCIAL_BACKUP_KEK` GitHub Actions secret).
3. Store copy #2 somewhere **independent of both Supabase and GitHub** — a password manager,
   a printed copy in a safe, or a hardware token. This is the copy that lets you recover even if
   GitHub and Supabase are both unavailable at once.
4. Do not let a third copy exist anywhere — including this terminal's scrollback. Clear it.
5. Rotating the key later: generate a new one the same way; old backups keep decrypting with
   whichever key was current when they were made (each backup's manifest could record a `kek_id`
   label for this, not yet wired up — a Phase 3 detail, not a blocker).

This script never performs any of these steps for you — it only ever prints a key to your
terminal once, and never writes, uploads, or stores it anywhere itself.

## Not yet done (Phase 3+, needs separate approval)

- Enabling the GitHub Actions `schedule:` trigger (currently `workflow_dispatch` only).
- Real production KEK generation and offline custody (procedure above, action still pending).
- Running a real backup against production data (everything proven so far uses synthetic data
  only, per instruction).
- `kek_id` labeling for key-rotation tracking in the manifest.
- The manager-only Backup Management screen and filtered accounting exports (UI, separate scope).
