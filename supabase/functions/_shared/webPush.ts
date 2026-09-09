/**
 * Web Push (browser/PWA) sender — signs and delivers via VAPID, using the same
 * `web-push` library the ecosystem standardizes on (works fine as an `npm:` import
 * under the Supabase Edge Functions Deno runtime).
 *
 * Requires env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: or
 * https: URL identifying the sender, per the Web Push spec).
 */
import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let vapidConfigured = false;

function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@shirafit.app";
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

type WebPushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Sends a push to every subscription on file for a user. Best-effort per-subscription:
 * a single failed/expired endpoint doesn't stop delivery to the user's other devices.
 * Expired subscriptions (410 Gone / 404) are pruned automatically.
 */
export async function sendWebPushToUser(
  adminClient: SupabaseClient,
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown> }
): Promise<{ sent: number; pruned: number }> {
  ensureVapidConfigured();

  const { data: subs } = await adminClient
    .from("web_push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  const rows = (subs as WebPushSubscriptionRow[] | null) ?? [];
  if (rows.length === 0) return { sent: 0, pruned: 0 };

  const message = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          message
        );
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await adminClient.from("web_push_subscriptions").delete().eq("id", row.id);
          pruned += 1;
        }
        // Other errors (network blip, etc.) are swallowed — best-effort delivery.
      }
    })
  );

  return { sent, pruned };
}
