/**
 * Manager-only: issue a temporary password for a user's auth account.
 *
 * This must run with the service role key to access auth admin APIs.
 * It verifies the caller using their JWT, checks they are a manager, generates a
 * random password, sets it via the auth admin API, and flags the target profile so the
 * app forces a password change on their next login.
 *
 * Route: POST { user_id }  -> { ok: true, password }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const adminClient = createClient(url, serviceKey);

  const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
  const callerId = authData?.user?.id ?? null;
  if (authErr || !callerId) return json(401, { ok: false, error: "unauthorized" });

  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("user_id", callerId)
    .maybeSingle();
  const role = (callerProfile as { role?: string } | null)?.role ?? "";
  if (role !== "manager") return json(403, { ok: false, error: "forbidden" });

  let body: { user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }
  const userId = String(body.user_id ?? "").trim();
  if (!userId) return json(400, { ok: false, error: "user_id required" });

  const { data: targetProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const targetRole = (targetProfile as { role?: string } | null)?.role ?? "";
  if (!targetRole) return json(404, { ok: false, error: "user_not_found" });
  if (targetRole === "manager") return json(403, { ok: false, error: "cannot_edit_manager" });

  const tempPassword = generateTempPassword();
  const { error: pwError } = await adminClient.auth.admin.updateUserById(userId, { password: tempPassword });
  if (pwError) return json(400, { ok: false, error: pwError.message });

  const { error: profileError } = await adminClient
    .from("profiles")
    .update({ must_change_password: true, temp_password_plaintext: tempPassword })
    .eq("user_id", userId);
  if (profileError) return json(400, { ok: false, error: profileError.message });

  return json(200, { ok: true, password: tempPassword });
});
