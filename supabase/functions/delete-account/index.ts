/**
 * Authenticated user deletes their own auth account and cascaded profile data.
 * Blocks managers (contact studio). Blocks coaches assigned to any session (FK restrict).
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

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const admin = createClient(url, serviceKey);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  const userId = authData?.user?.id ?? null;
  if (authErr || !userId) return json(401, { ok: false, error: "unauthorized" });

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileErr) return json(500, { ok: false, error: "profile_load_failed" });
  if (!profile) return json(404, { ok: false, error: "profile_not_found" });

  const role = (profile as { role?: string }).role ?? "";
  if (role === "manager") {
    return json(403, { ok: false, error: "cannot_delete_manager", code: "cannot_delete_manager" });
  }

  if (role === "coach") {
    const { count, error: cntErr } = await admin
      .from("training_sessions")
      .select("*", { count: "exact", head: true })
      .eq("coach_id", userId);
    if (cntErr) return json(500, { ok: false, error: "session_check_failed" });
    if ((count ?? 0) > 0) {
      return json(403, { ok: false, error: "coach_has_sessions", code: "coach_has_sessions" });
    }
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    return json(500, { ok: false, error: delErr.message ?? "delete_failed" });
  }

  return json(200, { ok: true });
});
