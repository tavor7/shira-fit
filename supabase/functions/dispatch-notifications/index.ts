/**
 * Process pending WhatsApp rows in notification_deliveries.
 * POST { "limit": 50 } — Authorization: Bearer CRON_SECRET
 *
 * No-ops when rollout_mode=off or WHATSAPP_ACCESS_TOKEN is unset (marks pending as skipped).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppTemplate, templateFromDelivery } from "../_shared/whatsapp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DeliveryRow = {
  id: string;
  user_id: string;
  notification_type: string;
  payload: Record<string, unknown>;
};

export async function processPendingDeliveries(
  admin: ReturnType<typeof createClient>,
  limit: number
): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  const { data: settings } = await admin.from("app_settings").select("whatsapp_rollout_mode").eq("id", 1).maybeSingle();
  const mode = (settings as { whatsapp_rollout_mode?: string } | null)?.whatsapp_rollout_mode ?? "off";

  if (mode === "off") {
    return stats;
  }

  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  const { data: rows, error } = await admin
    .from("notification_deliveries")
    .select("id, user_id, notification_type, payload")
    .eq("channel", "whatsapp")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !rows?.length) {
    return stats;
  }

  for (const row of rows as DeliveryRow[]) {
    stats.processed += 1;

    const isManagerTest = row.notification_type === "manager_test";
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    const { data: profile } = await admin
      .from("profiles")
      .select("whatsapp_phone_e164, whatsapp_notifications_enabled, phone")
      .eq("user_id", row.user_id)
      .maybeSingle();

    const prof = profile as {
      whatsapp_phone_e164?: string;
      whatsapp_notifications_enabled?: boolean;
      phone?: string;
    } | null;

    const phoneE164 = isManagerTest
      ? String(payload.phone_e164 ?? prof?.whatsapp_phone_e164 ?? "")
      : prof?.whatsapp_phone_e164 ?? "";

    if (!phoneE164) {
      await admin
        .from("notification_deliveries")
        .update({ status: "skipped", skip_reason: "user_not_eligible" })
        .eq("id", row.id);
      stats.skipped += 1;
      continue;
    }

    if (!isManagerTest && (!prof?.whatsapp_notifications_enabled || !prof.whatsapp_phone_e164)) {
      await admin
        .from("notification_deliveries")
        .update({ status: "skipped", skip_reason: "user_not_eligible" })
        .eq("id", row.id);
      stats.skipped += 1;
      continue;
    }

    if (mode === "testing" && !isManagerTest) {
      const { data: inTest } = await admin
        .from("whatsapp_test_users")
        .select("user_id")
        .eq("user_id", row.user_id)
        .maybeSingle();
      if (!inTest) {
        await admin
          .from("notification_deliveries")
          .update({ status: "skipped", skip_reason: "not_test_user" })
          .eq("id", row.id);
        stats.skipped += 1;
        continue;
      }
    }

    if (!token || !phoneNumberId) {
      await admin
        .from("notification_deliveries")
        .update({ status: "skipped", skip_reason: "whatsapp_not_configured" })
        .eq("id", row.id);
      stats.skipped += 1;
      continue;
    }

    const tpl = isManagerTest
      ? templateFromDelivery(String(payload.template ?? "waitlist_spot"), payload)
      : templateFromDelivery(row.notification_type, payload);
    const result = await sendWhatsAppTemplate(phoneE164, tpl);

    if (result.ok) {
      await admin
        .from("notification_deliveries")
        .update({
          status: "sent",
          provider_message_id: result.messageId,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", row.id);
      stats.sent += 1;
    } else {
      await admin
        .from("notification_deliveries")
        .update({
          status: "failed",
          error_message: result.error,
        })
        .eq("id", row.id);
      stats.failed += 1;
    }
  }

  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret) {
    return new Response(JSON.stringify({ error: "missing_cron_secret" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (auth !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let limit = 50;
  try {
    const body = await req.json();
    if (typeof body?.limit === "number" && body.limit > 0) {
      limit = Math.min(body.limit, 100);
    }
  } catch {
    // empty body ok
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, key);

  const stats = await processPendingDeliveries(admin, limit);

  return new Response(JSON.stringify({ ok: true, ...stats }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
