import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString, redactConnectionString } from "./pg-exec.js";

// Connection-only health check: SELECT 1 against FINANCIAL_BACKUP_SOURCE_URL, nothing else. No
// pg_dump, no R2 touch, no schema/data read. Exists specifically so a new or rotated
// FINANCIAL_BACKUP_SOURCE_URL can be proven reachable before ever running a real backup against
// it -- running the full dump is not an acceptable substitute for this, since a dump mutates
// nothing but does read the entire financial dataset.

// Forces sslmode=verify-full unconditionally -- this is the one property this check exists to
// prove, so it must never be silently satisfiable by a weaker mode (verify-full validates the
// server certificate against a trusted CA AND that its hostname matches, unlike "require", which
// encrypts but accepts any certificate). Takes effect even if the secret's own connection string
// already specifies a different sslmode.
export function withVerifyFullSsl(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

async function main() {
  const { FINANCIAL_BACKUP_SOURCE_URL } = requireEnv(["FINANCIAL_BACKUP_SOURCE_URL"]);
  const connStr = dockerizeConnectionString(withVerifyFullSsl(FINANCIAL_BACKUP_SOURCE_URL));

  console.log("Connectivity check: SELECT 1 only -- no pg_dump, no R2 upload, no financial data read.");
  console.log("TLS: sslmode=verify-full (server certificate chain + hostname both verified).");

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
