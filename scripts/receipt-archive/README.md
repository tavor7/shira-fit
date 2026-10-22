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

## Notes

- `out/` is gitignored — manifest and checkpoint files are local run artifacts, not committed.
- The manifest never contains customer names, amounts, or other financial PII — only path, size, hash, document id/number, and archive status.
- Re-running `backfill` (dry-run or live) is safe: already-archived objects (per the local manifest and/or an R2 HEAD check) are skipped, and progress resumes from the last checkpoint.
