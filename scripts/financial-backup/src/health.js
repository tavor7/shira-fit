import { listManifestKeys, getObject, objectExists, KEYS } from "./r2.js";

// Durable backup-run metadata and health reporting, WITHOUT a new Postgres table or migration
// (none has been authorized/deployed for this feature). Each backup's manifest, once uploaded to
// R2, IS its durable run record -- immutable, under the same Bucket Lock as everything else in
// this archive, readable with only the reader credential. This script lists and aggregates them.
// A completed backup requires schema + data + manifest all present and hash-verified; the
// manifest is deliberately uploaded LAST in dump.js, so "manifest exists" already means
// "complete" -- but this script re-verifies schema/data presence independently anyway, rather
// than trusting that invariant blindly (requirement: "incomplete backup sets cannot be reported
// as successful").

const CRON_SCHEDULE_DESCRIPTION = "not yet scheduled (workflow_dispatch only, Phase 2)";

async function loadManifest(key) {
  return JSON.parse((await getObject(key)).toString("utf8"));
}

async function main() {
  const manifestKeys = await listManifestKeys();
  const runs = [];

  for (const key of manifestKeys) {
    const manifest = await loadManifest(key);
    // Test/dry-run backups (source.label !== "production") are excluded from health aggregates --
    // they're real objects under Bucket Lock (can never be deleted) but must never count toward
    // or pollute the metrics a manager-facing health screen would show.
    if (manifest.source?.label !== "production") continue;
    const schemaOk = await objectExists(KEYS.schema(manifest.backup_id));
    const dataOk = await objectExists(KEYS.data(manifest.backup_id));
    const complete = schemaOk && dataOk;
    runs.push({
      backup_id: manifest.backup_id,
      created_at: manifest.created_at,
      schema_status: schemaOk ? "present" : "MISSING",
      data_status: dataOk ? "present" : "MISSING",
      schema_key: manifest.schema.r2_key,
      data_key: manifest.data.r2_key,
      schema_size_bytes: manifest.schema.size_bytes_ciphertext,
      data_size_bytes: manifest.data.size_bytes_ciphertext,
      complete,
    });
  }

  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const lastSuccessful = runs.find((r) => r.complete);
  const incomplete = runs.filter((r) => !r.complete);

  const health = {
    total_backups: runs.length,
    complete_backups: runs.length - incomplete.length,
    incomplete_backups: incomplete.length,
    last_successful_backup: lastSuccessful
      ? { backup_id: lastSuccessful.backup_id, created_at: lastSuccessful.created_at }
      : null,
    last_verified_backup: null, // populated once verify-remote.js (R2-integrity pass) has run at least once
    next_scheduled_backup: CRON_SCHEDULE_DESCRIPTION,
    total_size_bytes: runs.reduce((sum, r) => sum + (r.schema_size_bytes || 0) + (r.data_size_bytes || 0), 0),
    health_status: incomplete.length > 0 ? "critical" : runs.length === 0 ? "no_backups_yet" : "healthy",
  };

  console.log(JSON.stringify({ health, runs }, null, 2));

  if (incomplete.length > 0) {
    console.error(`\n${incomplete.length} backup(s) have a manifest but a MISSING schema or data artifact -- never report these as successful:`);
    for (const r of incomplete) console.error(`  ${r.backup_id}: schema=${r.schema_status} data=${r.data_status}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
