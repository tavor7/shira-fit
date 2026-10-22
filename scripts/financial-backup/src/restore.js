import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString } from "./pg-exec.js";
import { envelopeDecrypt } from "./crypto.js";

function parseBufferFields(obj) {
  return { ...obj, ciphertext: Buffer.from(obj.ciphertext, "base64") };
}

async function main() {
  const { FINANCIAL_BACKUP_RUN_DIR, FINANCIAL_BACKUP_TARGET_URL, FINANCIAL_BACKUP_TEST_KEK } = requireEnv([
    "FINANCIAL_BACKUP_RUN_DIR",
    "FINANCIAL_BACKUP_TARGET_URL",
    "FINANCIAL_BACKUP_TEST_KEK",
  ]);
  const kek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");

  console.log("1. Reading + decrypting schema and data artifacts...");
  const schemaEnvRaw = JSON.parse(await readFile(path.join(FINANCIAL_BACKUP_RUN_DIR, "schema.sql.enc.json"), "utf8"));
  const dataEnvRaw = JSON.parse(await readFile(path.join(FINANCIAL_BACKUP_RUN_DIR, "data.sql.enc.json"), "utf8"));
  const schemaSql = envelopeDecrypt(kek, parseBufferFields(schemaEnvRaw));
  const dataSql = envelopeDecrypt(kek, parseBufferFields(dataEnvRaw));
  console.log(`   schema: ${schemaSql.length} bytes (hash verified), data: ${dataSql.length} bytes (hash verified)`);

  const tmp = await mkdtemp(path.join(tmpdir(), "financial-restore-"));
  const schemaPath = path.join(tmp, "schema.sql");
  const dataPath = path.join(tmp, "data.sql");
  await writeFile(schemaPath, schemaSql);
  await writeFile(dataPath, dataSql);

  console.log("2. Applying schema to target...");
  await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, schemaPath);

  console.log("3. Applying data to target (triggers disabled for the load, per the dump's own --disable-triggers statements)...");
  await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, dataPath);

  console.log("\nRestore complete. Run `npm run verify` next to check the result.");
  console.log(`(Working files left at ${tmp} for inspection.)`);
}

async function runPsqlFile(connStr, filePath) {
  const content = await readFile(filePath);
  const { stderr } = await runPgTool(
    "psql",
    [dockerizeConnectionString(connStr), "-v", "ON_ERROR_STOP=1", "-f", "/dev/stdin"],
    { input: content }
  );
  if (stderr && stderr.trim()) console.log(`   (psql notices suppressed, ${stderr.trim().split("\n").length} lines)`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
