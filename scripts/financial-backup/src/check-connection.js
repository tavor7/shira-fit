import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString, redactConnectionString } from "./pg-exec.js";

// Connection-only health check: SELECT 1 against FINANCIAL_BACKUP_SOURCE_URL, nothing else. No
// pg_dump, no R2 touch, no schema/data read. Exists specifically so a new or rotated
// FINANCIAL_BACKUP_SOURCE_URL can be proven reachable before ever running a real backup against
// it -- running the full dump is not an acceptable substitute for this, since a dump mutates
// nothing but does read the entire financial dataset.
//
// TLS enforcement (sslmode=verify-full against Supabase's own bundled root CA) is NOT done here
// -- it's centralized in pg-exec.js's dockerizeConnectionString/withEnforcedTls, which every
// Postgres-connecting script in this tool (this one, dump.js, restore.js, verify.js) already
// routes through, so the same enforcement applies consistently everywhere rather than being
// re-implemented per script.

async function main() {
  const { FINANCIAL_BACKUP_SOURCE_URL } = requireEnv(["FINANCIAL_BACKUP_SOURCE_URL"]);
  const connStr = dockerizeConnectionString(FINANCIAL_BACKUP_SOURCE_URL);

  console.log("Connectivity check: SELECT 1 only -- no pg_dump, no R2 upload, no financial data read.");
  console.log(
    process.env.PG_TOOLS_VIA_DOCKER === "1"
      ? "TLS: enforcement skipped (PG_TOOLS_VIA_DOCKER=1 -- local test container, no TLS configured)."
      : "TLS: sslmode=verify-full against Supabase's bundled root CA (server certificate chain + hostname both verified)."
  );

  let result;
  try {
    const { stdout } = await runPgTool("psql", [connStr, "-Atq", "-c", "SELECT 1;"]);
    result = stdout.toString().trim();
  } catch (err) {
    throw new Error(redactConnectionString(err.message));
  }

  if (result !== "1") {
    throw new Error(`Unexpected result from SELECT 1: "${result}"`);
  }

  console.log("OK -- connection succeeded, SELECT 1 returned 1.");
}

main().catch((err) => {
  console.error("FAILED:", redactConnectionString(err.message));
  process.exit(1);
});
