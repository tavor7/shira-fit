/**
 * Call when a spot opens (after cancel/remove). POST { "session_id": "uuid" }
 * Authorization: Bearer CRON_SECRET (same as cron) or service invoke.
 * Sends Expo push to the first waitlisted user who could actually register (FIFO by requested_at).
 * Sends nothing for a session that has started, is hidden or is closed for registration.
 * Does not remove waitlist rows — staff can see the full list and add people manually.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWebPushToUser } from "../_shared/webPush.ts";

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

  const { data: skipReason, error: skipError } = await supabase.rpc("_waitlist_notify_skip_reason", {
    p_session_id: sessionId,
  });
  // A failed check must not lose a genuine opening, so only a definite answer stops the message.
  if (skipError) console.error(`notify-waitlist: eligibility check failed: ${skipError.message}`);
  if (skipReason)
    return new Response(JSON.stringify({ ok: true, notified: false, reason: skipReason }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const { data: firstUserId, error: firstError } = await supabase.rpc("_waitlist_first_eligible_user", {
    p_session_id: sessionId,
  });
  if (firstError) console.error(`notify-waitlist: first in line lookup failed: ${firstError.message}`);

  if (!firstUserId)
    return new Response(JSON.stringify({ ok: true, notified: false }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  const { data: firstProfile } = await supabase
    .from("profiles")
    .select("expo_push_token")
    .eq("user_id", firstUserId)
    .maybeSingle();

  const { data: settings } = await supabase
    .from("app_settings")
    .select("push_notifications_enabled")
    .eq("id", 1)
    .maybeSingle();
  const pushEnabled = (settings as { push_notifications_enabled?: boolean } | null)?.push_notifications_enabled !== false;

  if (!pushEnabled) {
    return new Response(JSON.stringify({ ok: true, notified: false, reason: "push_disabled" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Notification content is always Hebrew (matches every other push template in this codebase,
  // e.g. send_test_push_notification's 'waitlist_spot' case in 20260910120000_restore_descriptive_titles.sql).
  const dateParts = String(sess.session_date).split("-");
  const dateLabel = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : String(sess.session_date);
  const timeLabel = String(sess.start_time).slice(0, 5);
  const waitlistTitle = "התפנה מקום";
  const waitlistBody = `התפנה מקום לאימון בתאריך ${dateLabel} בשעה ${timeLabel}. היכנסו לאפליקציה כדי להירשם.`;

  const token = (firstProfile as { expo_push_token?: string } | null)?.expo_push_token;
  if (token) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        title: waitlistTitle,
        body: waitlistBody,
        data: { session_id: sessionId },
      }),
    });
  }

  try {
    await sendWebPushToUser(
      supabase,
      firstUserId,
      {
        title: waitlistTitle,
        body: waitlistBody,
        data: { session_id: sessionId },
      },
      "waitlist_spot"
    );
  } catch {
    // Best-effort — a missing VAPID config or an offline browser shouldn't fail the response.
  }

  return new Response(JSON.stringify({ ok: true, notified: true, user_id: firstUserId }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
