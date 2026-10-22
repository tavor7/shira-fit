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
    encryption: { algorithm: "aes-256-gcm-envelope", kek_id: process.env.FINANCIAL_BACKUP_KEK_ID ?? "unset" },
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
