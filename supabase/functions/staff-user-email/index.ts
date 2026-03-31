/**
 * Staff-only: get/update a user's auth email.
 *
 * This must run with the service role key to access auth admin APIs.
 * It verifies the caller using their JWT and checks they are coach/manager.
 *
 * Routes:
 * - GET  ?user_id=<uuid>            -> { ok: true, email }
 * - POST { user_id, new_email }     -> { ok: true }
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

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const adminClient = createClient(url, serviceKey);
  // Verify caller with their JWT (pass token explicitly to avoid header merge issues).
  const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
  const callerId = authData?.user?.id ?? null;
  if (authErr || !callerId) return json(401, { ok: false, error: "unauthorized" });

  // Check caller is coach or manager (profile role).
  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("user_id", callerId)
    .maybeSingle();
  const role = (callerProfile as { role?: string } | null)?.role ?? "";
  if (role !== "coach" && role !== "manager") return json(403, { ok: false, error: "forbidden" });

  const requestUrl = new URL(req.url);
  if (req.method === "GET") {
    const userId = requestUrl.searchParams.get("user_id");
    if (!userId) return json(400, { ok: false, error: "user_id required" });

    const { data, error } = await adminClient.auth.admin.getUserById(userId);
    if (error || !data?.user) return json(404, { ok: false, error: "user_not_found" });
    return json(200, { ok: true, email: data.user.email ?? "" });
  }

  if (req.method === "POST") {
    let body: { action?: "get" | "set"; user_id?: string; new_email?: string };
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: "json" });
    }
    const action = body.action ?? "set";
    const userId = body.user_id;
    if (!userId) return json(400, { ok: false, error: "user_id required" });

    // Extra rule: coaches cannot edit manager emails; managers can edit non-managers.
    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    const targetRole = (targetProfile as { role?: string } | null)?.role ?? "";
    if (targetRole === "manager") return json(403, { ok: false, error: "cannot_edit_manager" });
    if (role === "coach" && targetRole !== "athlete") return json(403, { ok: false, error: "forbidden" });

    if (action === "get") {
      const { data, error } = await adminClient.auth.admin.getUserById(userId);
      if (error || !data?.user) return json(404, { ok: false, error: "user_not_found" });
      return json(200, { ok: true, email: data.user.email ?? "" });
    }

    const newEmail = (body.new_email ?? "").trim();
    if (!newEmail) return json(400, { ok: false, error: "new_email required" });
    const { error } = await adminClient.auth.admin.updateUserById(userId, { email: newEmail });
    if (error) return json(400, { ok: false, error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { ok: false, error: "method_not_allowed" });
});

