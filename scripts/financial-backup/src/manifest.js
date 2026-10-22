// Versioned backup manifest. Each backup run produces exactly one manifest describing BOTH the
// schema snapshot and the data snapshot taken in the same run, under the same backup_id -- this
// is what guarantees a data backup is never paired with an incompatible schema: they are always
// produced and shipped together, never independently scheduled. (Requirement: "never assume a
// weekly schema backup is compatible with every subsequent data backup" -- solved by not having
// a separate weekly cadence at all.)

export const MANIFEST_VERSION = 1;

export function buildManifest({
  backupId,
  createdAt,
  schemaScope,
  dataTables,
  snapshotId,
  schemaArtifact,
  dataArtifact,
  postgresVersion,
  sourceLabel,
  kekId,
}) {
  return {
    manifest_version: MANIFEST_VERSION,
    backup_id: backupId,
    created_at: createdAt,
    kind: "financial-backup",
    // Proof that schema and data came from one shared MVCC snapshot (see pg-exec.js
    // PgSnapshotSession) -- the consistency guarantee this backup actually provides.
    consistency: { mechanism: "pg_export_snapshot + --snapshot on both pg_dump calls", snapshot_id: snapshotId },
    source: { postgres_version: postgresVersion, label: sourceLabel },
    // kek_id is a non-secret LABEL identifying which Key-Encrypting-Key was used (e.g.
    // "prod-2026-10" or "test-local") -- never the key itself, never a derivative of it. Lets
    // restore.js tell the operator which key a given backup needs, and lets key rotation keep
    // old backups decryptable: each one just remembers which key it was encrypted with.
    // "unlabeled" (rather than silently omitting the field) marks older/synthetic manifests
    // produced before this field existed or without an explicit label set -- still a valid,
    // restorable manifest, just without rotation tracking.
    encryption: { algorithm: "aes-256-gcm-envelope", kek_id: kekId || "unlabeled" },
    schema: {
      scope: schemaScope,
      size_bytes_plaintext: schemaArtifact.plaintextSize,
      size_bytes_ciphertext: schemaArtifact.ciphertextSize,
      sha256_plaintext: schemaArtifact.plaintextSha256,
      sha256_ciphertext: schemaArtifact.ciphertextSha256,
      r2_key: schemaArtifact.r2Key ?? null,
    },
    data: {
      tables: dataTables,
      size_bytes_plaintext: dataArtifact.plaintextSize,
      size_bytes_ciphertext: dataArtifact.ciphertextSize,
      sha256_plaintext: dataArtifact.plaintextSha256,
      sha256_ciphertext: dataArtifact.ciphertextSha256,
      r2_key: dataArtifact.r2Key ?? null,
    },
  };
}
