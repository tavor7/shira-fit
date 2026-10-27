import { requireEnv } from "./env.js";
import { KEYS, putAndVerify } from "./r2.js";

// Writes exactly one immutable restore-test result record. This is the ONLY thing this script
// does -- no restore, no download of real backup content, no decision-making about pass/fail
// (that already happened in the restore-test job; this just durably records the verdict it was
// given). Deliberately factored into its own script/job so that the R2 WRITER credential needed
// to persist the result is never handed to the job that actually downloads and restores a real
// backup into an ephemeral target -- see .github/workflows/financial-backup.yml's
// `record-restore-test-result` job, which runs this and nothing else, `needs: restore-test`, and
// never touches FINANCIAL_BACKUP_TARGET_URL or the restore/verify-production scripts at all.
//
// Required env:
//   RESTORE_TEST_BACKUP_ID   -- which backup was tested
//   RESTORE_TEST_RESULT      -- "passed" or "failed"
//   RESTORE_TEST_TRIGGER     -- "scheduled" or "manual"
// Optional:
//   RESTORE_TEST_DETAIL      -- short, non-sensitive free text (e.g. which check failed); never
//                               raw SQL or row contents -- this is written to a durable, public-
//                               within-the-bucket-readers record, same discipline as every other
//                               manifest/verification record in this archive.
//
// RESIDUAL RISK, documented rather than silently accepted: R2_ARCHIVE_WRITER_* is a bucket-wide
// credential (PutObject anywhere in the bucket) -- the same one dump.js uses to write
// schema/data/manifest objects. There is no Cloudflare account-level API token in this repo to
// even check whether a path-prefix-scoped R2 token is available, let alone provision one (see
// the Backup Management audit). The actual guarantee that this job only ever writes under
// db-backups/restore-tests/ is enforced ENTIRELY by this script's own code (KEYS.restoreTest()
// is the only key-building function it calls) plus job isolation (this job never receives
// FINANCIAL_BACKUP_TARGET_URL and never imports dump.js/restore.js) -- NOT by the credential
// itself, which could technically write anywhere in the bucket if this script's logic were
// changed. If that separation ever needs to be credential-enforced rather than code-enforced, a
// genuinely prefix-scoped R2 API token would need to be provisioned via the Cloudflare dashboard
// first -- a separate, explicit decision, not something to assume is already in place.

// Every real backup_id is a crypto.randomUUID() output (see dump.js) -- never anything else.
// RESTORE_TEST_BACKUP_ID ultimately traces back to either select-latest-verified-backup.js (safe
// by construction: only ever emits a backup_id it just read off a real manifest) or a manual
// workflow_dispatch's free-text `backup_id` input (NOT safe by construction -- a human can type
// anything). Rejecting anything that isn't a well-formed UUID here, before it's used to build an
// R2 object key, closes that gap at the one place a new key is actually constructed from it,
// regardless of which path the value came from.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const { RESTORE_TEST_BACKUP_ID, RESTORE_TEST_RESULT, RESTORE_TEST_TRIGGER } = requireEnv([
    "RESTORE_TEST_BACKUP_ID",
    "RESTORE_TEST_RESULT",
    "RESTORE_TEST_TRIGGER",
  ]);
  if (!UUID_RE.test(RESTORE_TEST_BACKUP_ID)) {
    throw new Error(
      `RESTORE_TEST_BACKUP_ID must be a well-formed UUID (every real backup_id is), got: "${RESTORE_TEST_BACKUP_ID}" -- ` +
        "refusing to construct an R2 object key from an unvalidated value."
    );
  }
  if (!["passed", "failed"].includes(RESTORE_TEST_RESULT)) {
    throw new Error(`RESTORE_TEST_RESULT must be "passed" or "failed", got: "${RESTORE_TEST_RESULT}"`);
  }
  if (!["scheduled", "manual"].includes(RESTORE_TEST_TRIGGER)) {
    throw new Error(`RESTORE_TEST_TRIGGER must be "scheduled" or "manual", got: "${RESTORE_TEST_TRIGGER}"`);
  }

  const testedAt = new Date().toISOString();
  const record = {
    restore_test_id: `${RESTORE_TEST_BACKUP_ID}-${testedAt}`,
    backup_id: RESTORE_TEST_BACKUP_ID,
    tested_at: testedAt,
    trigger: RESTORE_TEST_TRIGGER,
    result: RESTORE_TEST_RESULT,
    detail: process.env.RESTORE_TEST_DETAIL || null,
  };

  const key = KEYS.restoreTest(RESTORE_TEST_BACKUP_ID, testedAt);
  const body = Buffer.from(JSON.stringify(record, null, 2));
  const result = await putAndVerify(key, body, { contentType: "application/json" });
  console.log(`Restore-test result recorded: ${result.key} (sha256 ${result.sha256.slice(0, 12)}...)`);
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
