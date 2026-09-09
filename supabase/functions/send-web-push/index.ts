/**
 * Send a Web Push notification to every browser/PWA subscription a user has on file.
 * POST { user_id, title, body, data? }
 * Authorization: Bearer WEB_PUSH_INVOKE_SECRET (same pattern as notify-waitlist/CRON_SECRET —
 * called by Postgres triggers via pg_net, or directly by other Edge Functions).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWebPushToUser } from "../_shared/webPush.ts";

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

  const secret = Deno.env.get("WEB_PUSH_INVOKE_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret) return json(500, { ok: false, error: "missing_invoke_secret" });
  if (auth !== secret) return json(401, { ok: false, error: "unauthorized" });

  let body: { user_id?: string; title?: string; body?: string; data?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const userId = body.user_id;
  const title = body.title;
  const message = body.body;
  if (!userId || !title || !message) {
    return json(400, { ok: false, error: "user_id, title, and body are required" });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(url, key);

  try {
    const result = await sendWebPushToUser(adminClient, userId, {
      title,
      body: message,
      data: body.data,
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
