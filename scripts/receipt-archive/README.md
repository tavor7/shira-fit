# Receipt archive tooling (local only)

Local-only scripts for the independent R2 receipt backup project. Nothing here is
deployed as part of the app or edge functions — run it from a developer machine.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` if you haven't already (already done once).
3. **Edit `scripts/receipt-archive/.env.local` directly in your editor** and fill in:
   - `CF_ACCOUNT_ID` — your Cloudflare account id (not secret).
   - `R2_ARCHIVE_WRITER_ACCESS_KEY_ID` / `R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY` — from the `shirafit-archive-writer` R2 token.
   - `R2_ARCHIVE_READER_ACCESS_KEY_ID` / `R2_ARCHIVE_READER_SECRET_ACCESS_KEY` — from the `shirafit-archive-reader` R2 token.
   - `SB_URL` / `SB_SERVICE_ROLE_KEY` can stay blank — they fall back to the existing `supabase/.secrets/.env`.

   `.env.local` is gitignored. Do not paste these values into chat with an assistant — edit the file directly.

## Scripts

- `npm run verify` — connectivity + permission checks (writer list/scope, reader list/download, reader upload/delete rejection). Leaves one harmless object at `_verification/connectivity-probe.txt`.
- `npm run verify:lock` — dedicated Bucket Lock test: upload, read back, verify SHA-256, attempt overwrite, attempt delete. **If overwrite or delete succeeds, stop and do not proceed to the real backfill.** Leaves one harmless object under `_verification/bucket-lock-test-*.txt` permanently (expected, since retention is indefinite).
- `npm run list-storage` — read-only enumeration of `document-pdfs` in Supabase Storage. No downloads, no R2 calls.
- `npm run backfill:dry-run` — plans the historical archive against the real object list (checks what's already in R2 via HEAD) without downloading or uploading anything. Writes `out/manifest.jsonl` and `out/checkpoint.json` (gitignored).
- `npm run backfill` — the real, resumable, idempotent historical backfill. **Do not run until explicitly authorized** — this uploads every object in `document-pdfs` to the R2 archive.
- `npm run reconcile [-- --limit N]` (Backup Management Phase 9) — bounded, read-only: HEAD-checks up to `N` (default 500) `archive.r2_archive_jobs` rows marked `completed` in R2, reports any missing object to System Issues (never a push), and records the run in `archive.reconciliation_runs`. Never writes to R2, never re-queues anything. See `docs/backup-management/disaster-recovery.md`.
- `npm run backfill-pdf-sizes [-- --limit N]` (Backup Management) — bounded, resumable, idempotent: HEAD-checks up to `N` (default 200) `archive.document_pdf_versions` rows still missing a known size, and records each real Content-Length into the separate, insert-once `archive.document_pdf_version_sizes` supplementary table (never updates `document_pdf_versions` itself, never downloads PDF content, never writes to R2). Re-running only ever touches rows with no size recorded yet in either place -- safe to run repeatedly until the whole backlog is filled. **Not run yet -- awaiting explicit go-ahead before the first run against production.**

## Notes

- `out/` is gitignored — manifest and checkpoint files are local run artifacts, not committed.
- The manifest never contains customer names, amounts, or other financial PII — only path, size, hash, document id/number, and archive status.
- Re-running `backfill` (dry-run or live) is safe: already-archived objects (per the local manifest and/or an R2 HEAD check) are skipped, and progress resumes from the last checkpoint.
