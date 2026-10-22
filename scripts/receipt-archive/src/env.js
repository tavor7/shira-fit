import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoRoot = path.resolve(root, "..", "..");

// Load the existing Supabase secret file first (SB_URL / SB_SERVICE_ROLE_KEY),
// then the archive-specific .env.local — dotenv's default is to never override
// a var that's already set, so if .env.local leaves SB_URL/SB_SERVICE_ROLE_KEY
// blank, the values from supabase/.secrets/.env win instead of being blanked out.
loadDotenv({ path: path.join(repoRoot, "supabase", ".secrets", ".env") });
loadDotenv({ path: path.join(root, ".env.local") });

function mask(value) {
  if (!value) return "(missing)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)} (len ${value.length})`;
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
        `Fill them in at scripts/receipt-archive/.env.local (edit the file directly — do not paste secrets into chat).`
    );
  }
  const out = {};
  for (const n of names) out[n] = process.env[n];
  return out;
}

export function describeEnv(names) {
  // For status reporting only — never prints full secret values.
  return names.map((n) => `${n}=${mask(process.env[n])}`).join("\n");
}

export const env = process.env;
