/**
 * Manager-only: confirm a user's auth email without opening their inbox.
 *
 * POST { user_id: "<uuid>" }
 * Authorization: Bearer <caller access token>
 *
 * Env (Edge secrets):
 * - SB_URL
 * - SB_SERVICE_ROLE_KEY
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SB_URL") ?? "";
  const serviceKey = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json(500, { ok: false, error: "missing_secrets" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return json(401, { ok: false, error: "unauthorized" });

  const adminClient = createClient(url, serviceKey);

  // Verify caller with their JWT.
  const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
  const callerId = authData?.user?.id ?? null;
  if (authErr || !callerId) return json(401, { ok: false, error: "unauthorized" });

  // Check caller is manager.
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

  const userId = (body.user_id ?? "").trim();
  if (!userId) return json(400, { ok: false, error: "user_id required" });

  const { error } = await adminClient.auth.admin.updateUserById(userId, { email_confirm: true });
  if (error) return json(400, { ok: false, error: error.message });

  return json(200, { ok: true });
});
