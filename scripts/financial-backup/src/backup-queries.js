import { listManifestKeys, listVerificationKeys, listRestoreTestKeys, getObject } from "./r2.js";

// Small shared read-only helpers over the R2-resident backup records -- factored out because
// three different scripts (health.js, select-latest-verified-backup.js, scheduled-run-guard.js)
// all need "list the production manifests" / "list the ok verifications" and must agree on
// exactly the same filtering rules (test backups never count; a verification only counts for a
// backup that is itself production-labeled). Keeping one definition avoids these three scripts
// quietly drifting apart.

async function loadJson(key) {
  return JSON.parse((await getObject(key)).toString("utf8"));
}

/** Every production-labeled manifest, newest first. Test/dry-run manifests are excluded. */
export async function loadProductionManifests() {
  const keys = await listManifestKeys();
  const all = await Promise.all(keys.map(loadJson));
  return all.filter((m) => m.source?.label === "production").sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/** Every successful ("result":"ok") verification record for a production backup, newest first. */
export async function loadOkVerifications(productionBackupIds) {
  const keys = await listVerificationKeys();
  const all = await Promise.all(keys.map(loadJson));
  return all
    .filter((v) => productionBackupIds.has(v.backup_id) && v.result === "ok")
    .sort((a, b) => new Date(b.verified_at) - new Date(a.verified_at));
}

/** Every restore-test record ("result":"passed" or "failed"), newest first. */
export async function loadRestoreTestResults() {
  const keys = await listRestoreTestKeys();
  const all = await Promise.all(keys.map(loadJson));
  return all.sort((a, b) => new Date(b.tested_at) - new Date(a.tested_at));
}
