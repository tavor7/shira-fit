# Disaster recovery runbook

This is the operator-facing recovery guide for the two independent backup/archive systems in
this repo: the **financial database backup** (`scripts/financial-backup/`) and the **receipt/
invoice PDF archive** (`scripts/receipt-archive/`, `archive.*` schema). Both exist *outside*
Supabase's own infrastructure — in a separate Cloudflare R2 bucket with Bucket Lock — precisely
so a problem with the Supabase project itself (accidental data loss, a bad migration, account
compromise) doesn't also take out the backups.

Keep this doc in sync with the actual scripts; a recovery guide that's drifted from the real
commands is worse than none, because it's trusted.

## 1. Financial database is lost, corrupted, or needs point-in-time recovery

**Tooling:** `scripts/financial-backup/` — see that directory's own `README.md` for full detail
on the backup format, encryption history, and the restore-test workflow. This section is the
short version for an actual incident.

1. **Pick a backup.** Either:
   - Run `npm run health` (reader credential only) to see the latest successful backup and
     whether it's been remote-verified / restore-tested.
   - Or list `db-backups/manifests/` directly in R2 if Postgres-side status (Phase 4's
     `manager_get_backup_health()` RPC / the Backup Management screen) is itself unavailable —
     the manifests are the ultimate source of truth, not any cache of them.
2. **Restore into a throwaway target first, never directly into production.** Use the exact
   recipe the `restore-test` GitHub Actions job already runs (`.github/workflows/financial-
   backup.yml`): a fresh `postgres:17` container, the compat stub
   (`scripts/financial-backup/test/supabase-compat-stub.sql`), then `npm run restore` with
   `FINANCIAL_BACKUP_BACKUP_ID` set to the chosen backup. This never touches production — it
   proves the backup is genuinely restorable before you do anything irreversible.
3. **Run `npm run verify-production`** (the same structural/referential-integrity/row-count
   checks the automated restore-test uses) against that throwaway target. Do not proceed to step
   4 on a backup that fails this.
4. **Only once a backup has restored and verified cleanly**, work with Supabase support (or your
   own infrastructure access) on actually restoring it into the real project. This repo's tooling
   deliberately stops at "restore into an isolated target and prove it's good" — it does not
   contain a one-command "restore into production" path, by design (see `README.md`'s
   "Deliberately NOT done" list).
5. **After any real restore**, re-run `npm run verify-remote` against the backup you used and
   `npm run health`, and manually check `financial_backup_health_snapshot` /
   `manager_get_archive_health()` in the app once reachable again.

**If `npm run health` / the Backup Management screen is itself unreachable** (e.g. the whole
Supabase project is down): the backups still exist independently in R2. List
`db-backups/manifests/` directly with the reader credential (see `scripts/financial-backup/src/
r2.js`'s `listManifestKeys`) — this never depends on Postgres being up.

## 2. A specific backup is suspected corrupt / fails restore

Don't delete it — R2 Bucket Lock means you can't anyway (see `README.md`'s "R2 bucket & Bucket
Lock" section), and keeping it is useful for understanding what went wrong. Pick an *older*
verified backup instead (same `npm run health` output lists several) and follow section 1 from
step 2 with that one. File it as a finding — if one backup is bad, check whether others nearby in
time are too.

## 3. Receipt/invoice archive: a referenced object is missing or doesn't match in R2

**Tooling:** `scripts/receipt-archive/src/reconcile.js` (`npm run reconcile`, Phase 9) for
existence; `archive-document-pdf`'s `verify` mode (already scheduled) for content-hash
correctness.

1. **Existence check:** `npm run reconcile` (optionally `-- --limit N`) walks up to `N`
   `archive.r2_archive_jobs` rows marked `completed` that haven't been checked recently and HEADs
   each one in R2 with the **reader** credential only — it never writes, re-queues, or deletes
   anything. Missing objects are printed and reported to System Issues (`subsystem:
   receipt_archive`, `error_class: archive_object_missing`, severity `error` — this never sends a
   push notification).
2. **Content check:** the `archive-document-pdf` Edge Function's `verify` mode (cron-scheduled)
   re-downloads and re-hashes previously-archived objects against their stored `sha256`. A
   mismatch is already reported the same way (`archive.record_verification_result`,
   `error_class: archive_hash_mismatch`, severity `critical` — this is pre-existing behavior from
   before Backup Management and genuinely does enqueue a push; this doc does not change that).
3. **If an object is confirmed missing or corrupt:** the original PDF may still exist in Supabase
   Storage (`document-pdfs` bucket) if it hasn't been regenerated since. Check
   `archive.document_pdf_versions` for the `document_id` and compare against the live
   `documents.pdf_url` — if they match, the archive copy can be re-created by re-queuing that
   `document_pdf_versions` row's object for upload (this repo's tooling does not currently
   automate re-queuing from a reconcile finding — that's a deliberate "report, don't auto-act"
   boundary per Phase 9's own scope; do it by hand via the same path `archive-document-pdf`'s
   `process` mode already uses, or treat it as a manual data-recovery task if the Storage copy is
   also gone).

## 4. Everything (Supabase project itself) is gone

1. The financial backups and the receipt archive both live in Cloudflare R2, independent of
   Supabase — they survive a lost/deleted Supabase project.
2. Stand up a new Supabase project, re-apply `supabase/migrations/` in order (see the note below
   on migration replay — some older migrations have pre-existing, unrelated fresh-replay gaps;
   budget time to work through those, or restore schema from the newest financial backup's
   `schema.sql` instead of replaying migration history from scratch).
3. Restore data from the newest verified financial backup (section 1).
4. Re-point the `document-pdfs` Storage bucket / re-associate `pdf_url` values, or treat the
   receipt archive in R2 as authoritative and re-ingest from there if Storage itself is what was
   lost.
5. This scenario has never been rehearsed end-to-end — treat the steps above as a starting point,
   not a tested procedure.

## Known gaps (as of this writing)

- `financial_backup_record_health_snapshot` (Phase 4/8) exists but the GitHub Actions workflow
  does not yet call it — the Backup Management screen's financial-backup section will show "no
  data" until that write path is wired up (needs a new Supabase service-role credential in CI,
  called out separately for approval).
- A fresh `supabase db reset` replaying the full migration history from scratch currently fails
  in several places unrelated to Backup Management (see the migration-replay investigation
  findings elsewhere in this effort) — don't rely on full migration replay as a disaster-recovery
  path until that's separately resolved.
- `npm run reconcile`'s "missing in R2" finding does not auto-repair anything — see section 3,
  step 3.
