import { loadProductionManifests, loadOkVerifications } from "./backup-queries.js";

// Picks "the latest eligible, fully verified backup" for an automatic (unattended) restore-test
// run -- so the weekly schedule never needs a human to supply a backup_id. "Eligible" means: a
// production backup whose own SHA-256 remote verification already succeeded (never restore-test
// a backup nobody has confirmed is even byte-intact yet -- that would waste the restore-test run
// proving nothing). Deliberately the newest ELIGIBLE one, not just the newest backup outright --
// if the newest backup hasn't been remotely verified yet for some reason, this intentionally
// falls back to the next-newest one that has, rather than failing outright.
//
// Read-only: lists manifests and verification records with the reader credential only. Prints
// the chosen backup_id to stdout (and, in CI, to $GITHUB_OUTPUT) -- never touches anything.

async function main() {
  const manifests = await loadProductionManifests();
  if (manifests.length === 0) {
    throw new Error("No production backup exists yet -- nothing eligible for an automatic restore-test.");
  }
  const productionIds = new Set(manifests.map((m) => m.backup_id));
  const okVerifications = await loadOkVerifications(productionIds);
  const verifiedIds = new Set(okVerifications.map((v) => v.backup_id));

  const eligible = manifests.find((m) => verifiedIds.has(m.backup_id));
  if (!eligible) {
    throw new Error(
      `No production backup has a successful remote verification yet (checked ${manifests.length} backup(s)) -- ` +
        "nothing eligible for an automatic restore-test. Run verify-remote.js against the latest backup first."
    );
  }

  if (eligible.backup_id !== manifests[0].backup_id) {
    console.error(
      `Note: the newest backup (${manifests[0].backup_id}, ${manifests[0].created_at}) has not been remotely verified yet -- ` +
        `falling back to the newest VERIFIED one instead.`
    );
  }

  console.log(eligible.backup_id);
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(process.env.GITHUB_OUTPUT, `backup_id=${eligible.backup_id}\n`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
