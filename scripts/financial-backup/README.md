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

## Not yet done (Phase 2+, needs separate approval)

- R2 upload (credentials, dedicated prefix, Bucket Lock key scheme).
- The GitHub Actions `schedule:` trigger (currently `workflow_dispatch` only).
- Real production KEK generation and offline custody.
- `archive.db_backup_runs` table / health metrics / alerting.
