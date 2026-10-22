import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoRoot = path.resolve(root, "..", "..");

// Fallback to the existing gitignored Supabase secret file for SB_URL/SB_SERVICE_ROLE_KEY,
// then layer this tool's own .env.local on top (same pattern as scripts/receipt-archive/).
loadDotenv({ path: path.join(repoRoot, "supabase", ".secrets", ".env") });
loadDotenv({ path: path.join(root, ".env.local") });

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. Set them in scripts/financial-backup/.env.local.`
    );
  }
  const out = {};
  for (const n of names) out[n] = process.env[n];
  return out;
}

export const env = process.env;
