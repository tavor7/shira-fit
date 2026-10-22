import { listManifestKeys, listVerificationKeys, getObject, objectExists, KEYS } from "./r2.js";

// Durable backup-run metadata and health reporting, WITHOUT a new Postgres table or migration
// (none has been authorized/deployed for this feature). Each backup's manifest, and each
// verification record (see verify-remote.js), once uploaded to R2, IS the durable run record --
// immutable, under the same Bucket Lock as everything else in this archive, readable with only
// the reader credential. This script lists and aggregates them.
//
// Staleness (new): "the most recent manifest is internally consistent" and "a production backup
// actually happened recently" are two different questions -- a schema/data pair can be perfectly
// well-formed and still be three days old because the scheduled job silently stopped running.
// This script answers both, separately, and the second one is what actually catches a missed
// backup -- never report health solely from the shape of the latest manifest.

const DEFAULT_STALE_THRESHOLD_HOURS = 36;

async function loadJson(key) {
  return JSON.parse((await getObject(key)).toString("utf8"));
}

function hoursSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  return (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

async function main() {
  const staleThresholdHours = Number(process.env.FINANCIAL_BACKUP_STALE_THRESHOLD_HOURS) || DEFAULT_STALE_THRESHOLD_HOURS;

  const manifestKeys = await listManifestKeys();
  const allManifests = await Promise.all(manifestKeys.map(loadJson));
  // Test/dry-run backups are real, permanent R2 objects (Bucket Lock) but must never count
  // toward or be mistaken for production health -- only source.label === "production" counts.
  const manifests = allManifests.filter((m) => m.source?.label === "production");

  const runs = [];
  for (const manifest of manifests) {
    const legacy = manifest.encryption?.algorithm === "aes-256-gcm-envelope";
    const schemaOk = await objectExists(KEYS.schema(manifest.backup_id, { legacy }));
    const dataOk = await objectExists(KEYS.data(manifest.backup_id, { legacy }));
    runs.push({
      backup_id: manifest.backup_id,
      created_at: manifest.created_at,
      format: manifest.encryption?.algorithm ?? "unknown",
      kek_id: manifest.encryption?.kek_id ?? null,
      schema_status: schemaOk ? "present" : "MISSING",
      data_status: dataOk ? "present" : "MISSING",
      schema_key: manifest.schema.r2_key,
      data_key: manifest.data.r2_key,
      schema_size_bytes: manifest.schema.size_bytes_ciphertext,
      data_size_bytes: manifest.data.size_bytes_ciphertext,
      complete: schemaOk && dataOk,
    });
  }
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const lastSuccessful = runs.find((r) => r.complete);
  const incomplete = runs.filter((r) => !r.complete);

  const verificationKeys = await listVerificationKeys();
  const allVerifications = await Promise.all(verificationKeys.map(loadJson));
  // A verification record only counts if it's for a backup that is ITSELF a production run --
  // closes the gap where a test backup's verification could otherwise be read as a production
  // "last verified" signal.
  const productionBackupIds = new Set(manifests.map((m) => m.backup_id));
  const verifications = allVerifications
    .filter((v) => productionBackupIds.has(v.backup_id) && v.result === "ok")
    .sort((a, b) => new Date(b.verified_at) - new Date(a.verified_at));
  const lastVerified = verifications[0] ?? null;

  const hoursSinceLastSuccessful = lastSuccessful ? hoursSince(lastSuccessful.created_at) : Infinity;
  const hoursSinceLastVerified = lastVerified ? hoursSince(lastVerified.verified_at) : Infinity;
  const backupIsStale = hoursSinceLastSuccessful > staleThresholdHours;
  const verificationIsStale = hoursSinceLastVerified > staleThresholdHours;

  const health = {
    total_backups: runs.length,
    complete_backups: runs.length - incomplete.length,
    incomplete_backups: incomplete.length,
    last_successful_backup: lastSuccessful ? { backup_id: lastSuccessful.backup_id, created_at: lastSuccessful.created_at } : null,
    last_verified_backup: lastVerified ? { backup_id: lastVerified.backup_id, verified_at: lastVerified.verified_at } : null,
    stale_threshold_hours: staleThresholdHours,
    hours_since_last_successful_backup: Number.isFinite(hoursSinceLastSuccessful) ? Math.round(hoursSinceLastSuccessful * 10) / 10 : null,
    hours_since_last_verified_backup: Number.isFinite(hoursSinceLastVerified) ? Math.round(hoursSinceLastVerified * 10) / 10 : null,
    backup_is_stale: runs.length === 0 || backupIsStale,
    verification_is_stale: verifications.length === 0 || verificationIsStale,
    next_scheduled_backup: "not yet scheduled (workflow_dispatch only, Phase 2/3)",
    total_size_bytes: runs.reduce((sum, r) => sum + (r.schema_size_bytes || 0) + (r.data_size_bytes || 0), 0),
    health_status:
      incomplete.length > 0 || runs.length === 0 || backupIsStale || verifications.length === 0 || verificationIsStale
        ? "critical"
        : "healthy",
  };

  console.log(JSON.stringify({ health, runs }, null, 2));

  if (incomplete.length > 0) {
    console.error(`\n${incomplete.length} backup(s) have a manifest but a MISSING schema or data artifact -- never report these as successful:`);
    for (const r of incomplete) console.error(`  ${r.backup_id}: schema=${r.schema_status} data=${r.data_status}`);
  }
  if (runs.length === 0) {
    console.error("\nNo production backup has ever completed.");
  } else if (backupIsStale) {
    console.error(`\nSTALE: last successful production backup was ${health.hours_since_last_successful_backup}h ago (threshold ${staleThresholdHours}h).`);
  }
  if (verifications.length === 0) {
    console.error("\nNo production backup has ever been independently re-verified (run verify-remote.js).");
  } else if (verificationIsStale) {
    console.error(`\nSTALE: last verification was ${health.hours_since_last_verified_backup}h ago (threshold ${staleThresholdHours}h).`);
  }

  if (health.health_status !== "healthy") process.exitCode = 1;
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
