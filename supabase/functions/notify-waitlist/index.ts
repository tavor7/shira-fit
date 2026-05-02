/**
 * Call when a spot opens (after cancel/remove). POST { "session_id": "uuid" }
 * Authorization: Bearer CRON_SECRET (same as cron) or service invoke.
 * Sends Expo push to first waitlisted user (FIFO by requested_at).
 * Does not remove waitlist rows — staff can see the full list and add people manually.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret)
    return new Response(JSON.stringify({ error: "missing_cron_secret" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (auth !== secret)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  let body: { session_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "json" }), { status: 400, headers: cors });
  }
  const sessionId = body.session_id;
  if (!sessionId)
    return new Response(JSON.stringify({ error: "session_id required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key);

  const { data: sess } = await supabase
    .from("training_sessions")
    .select("id, max_participants, session_date, start_time")
    .eq("id", sessionId)
    .single();
  if (!sess) return new Response(JSON.stringify({ error: "session not found" }), { status: 404, headers: cors });

  const { count: regCount } = await supabase
    .from("session_registrations")
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "active");
  const { count: manualCount } = await supabase
    .from("session_manual_participants")
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId);
  const filled = (regCount ?? 0) + (manualCount ?? 0);
  if (filled >= sess.max_participants)
    return new Response(JSON.stringify({ ok: true, notified: false, reason: "still_full" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const { data: first } = await supabase
    .from("waitlist_requests")
    .select("id, user_id, profiles(expo_push_token)")
    .eq("session_id", sessionId)
    .order("requested_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!first?.user_id)
    return new Response(JSON.stringify({ ok: true, notified: false }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const token = (first as { profiles?: { expo_push_token?: string } }).profiles?.expo_push_token;
  if (token) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        title: "Spot available",
        body: `A spot opened for ${sess.session_date} ${sess.start_time}. Open the app to register.`,
        data: { session_id: sessionId },
      }),
    });
  }

  return new Response(JSON.stringify({ ok: true, notified: true, user_id: first.user_id }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
