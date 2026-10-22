import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";

const STORAGE_BUCKET = "document-pdfs";

// Read-only usage by this tooling: Storage object listing + downloading bytes
// to hash/archive them. Never writes, never deletes, never touches public.*
// tables beyond simple SELECTs.
export function supabaseAdminClient() {
  const { SB_URL, SB_SERVICE_ROLE_KEY } = requireEnv(["SB_URL", "SB_SERVICE_ROLE_KEY"]);
  return createClient(SB_URL, SB_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export { STORAGE_BUCKET };

// Supabase Storage's list() is paginated and only lists one "folder" level at a
// time (it mirrors a filesystem view, not a flat key space like S3/R2). We walk
// the documents/{uuid}/ prefixes plus any top-level files to get a flat list of
// every object, mirroring how storage.objects.name is actually structured.
export async function listAllStorageObjects(supabase, { pageSize = 1000 } = {}) {
  const results = [];

  async function listDir(prefix) {
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Storage list(${JSON.stringify(prefix)}) failed: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const entry of data) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const isFile = entry.id !== null; // Supabase Storage: folders have id === null
        if (isFile) {
          results.push({
            name: fullPath,
            id: entry.id,
            updated_at: entry.updated_at,
            created_at: entry.created_at,
            size: entry.metadata?.size ?? null,
          });
        } else {
          await listDir(fullPath);
        }
      }

      if (data.length < pageSize) break;
      offset += pageSize;
    }
  }

  await listDir("");
  return results;
}

export async function downloadStorageObject(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(objectPath);
  if (error) throw new Error(`Storage download(${objectPath}) failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}
