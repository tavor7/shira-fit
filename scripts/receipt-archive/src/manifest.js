import { appendFile, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, "..", "out");
export const MANIFEST_PATH = path.join(OUT_DIR, "manifest.jsonl");
export const CHECKPOINT_PATH = path.join(OUT_DIR, "checkpoint.json");

export async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

// One JSON object per line — append-only, so an interrupted run never corrupts
// prior entries. No personal/financial fields are ever written here: only
// object identity, path, size, hash, and archive status.
export async function appendManifestEntry(entry) {
  await ensureOutDir();
  await appendFile(MANIFEST_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export async function loadManifestKeys() {
  try {
    const text = await readFile(MANIFEST_PATH, "utf8");
    const keys = new Set();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.archive_status === "done") keys.add(entry.original_path);
    }
    return keys;
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

export async function readCheckpoint() {
  try {
    const text = await readFile(CHECKPOINT_PATH, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return { lastIndexProcessed: -1 };
    throw err;
  }
}

export async function writeCheckpoint(checkpoint) {
  await ensureOutDir();
  await writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2), "utf8");
}
