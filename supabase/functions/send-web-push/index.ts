/**
 * Send a Web Push notification to every browser/PWA subscription a user has on file.
 * POST { user_id, title, body, data? }
 * Authorization: Bearer WEB_PUSH_INVOKE_SECRET (same pattern as notify-waitlist/CRON_SECRET —
 * called by Postgres triggers via pg_net, or directly by other Edge Functions).
 *
 * Optional `Idempotency-Key` header: when present, arbitrates duplicate delivery attempts against
 * system_push_idempotency_keys (added for the System Issues critical-push outbox, which is an
 * at-least-once sender and needs this). Existing callers that never send this header (waitlist/
 * series-notify/etc.) are completely unaffected — the check only runs when the header is present.
 *
 * State machine, not a permanent lock: a send that crashes mid-flight must still eventually be
 * retried, never permanently suppressed.
 *   - No row for the key: proceed, insert ('in_progress'), send; on success -> 'completed'; on
 *     failure -> delete the row so a legitimate retry with the same key is free to proceed.
 *   - Row 'completed': a genuine duplicate (e.g. the outbox's own at-least-once retry) — return the
 *     same success shape without sending again.
 *   - Row 'in_progress' and recent (<30s): another attempt is in flight right now — return a
 *     distinct "in-flight" response so the caller treats this as still-ambiguous, not a hard failure.
 *   - Row 'in_progress' and stale (>=30s): the previous attempt almost certainly crashed mid-send —
 *     reclaim the key (bump created_at) and send now, so the message is never permanently blackholed.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWebPushToUser } from "../_shared/webPush.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
};

const IDEMPOTENCY_RECLAIM_AFTER_MS = 30_000;

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

  let body: { user_id?: string; title?: string; body?: string; data?: Record<string, unknown>; kind?: string };
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

  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || null;

  if (idempotencyKey) {
    const { data: existing } = await adminClient
      .from("system_push_idempotency_keys")
      .select("status, created_at")
      .eq("key", idempotencyKey)
      .maybeSingle();

    if (existing?.status === "completed") {
      return json(200, { ok: true, deduplicated: true });
    }
    if (existing?.status === "in_progress") {
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      if (ageMs < IDEMPOTENCY_RECLAIM_AFTER_MS) {
        return json(202, { ok: false, error: "in_flight" });
      }
      // Stale lock: reclaim it rather than leaving the message permanently unsent.
      await adminClient
        .from("system_push_idempotency_keys")
        .update({ created_at: new Date().toISOString() })
        .eq("key", idempotencyKey)
        .eq("status", "in_progress");
    } else {
      const { error: insertError } = await adminClient
        .from("system_push_idempotency_keys")
        .insert({ key: idempotencyKey, status: "in_progress" });
      if (insertError) {
        // Lost the race to another concurrent request with the same key — treat as in-flight.
        return json(202, { ok: false, error: "in_flight" });
      }
    }
  }

  try {
    const result = await sendWebPushToUser(
      adminClient,
      userId,
      {
        title,
        body: message,
        data: body.data,
      },
      body.kind ?? null
    );
    if (idempotencyKey) {
      await adminClient
        .from("system_push_idempotency_keys")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("key", idempotencyKey);
    }
    return json(200, { ok: true, ...result });
  } catch (err) {
    if (idempotencyKey) {
      // Release the key so a legitimate retry is never permanently blocked by this failed attempt.
      await adminClient.from("system_push_idempotency_keys").delete().eq("key", idempotencyKey);
    }
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
