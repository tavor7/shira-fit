import { supabase } from "./supabase";
import { saveNotificationPrefs } from "./notificationPrefs";
import { syncExpoPushTokenIfNeeded } from "./pushTokenSync";
import { syncWebPushSubscriptionIfNeeded } from "./webPushSync";
import { ensureNotificationPermission } from "./sessionReminders";

/**
 * The single "turn notifications on" action — used by both the Alerts toggle and the
 * activation popup so they're guaranteed to behave identically, not two copies that can
 * drift apart.
 */
export async function activateAllNotifications(): Promise<void> {
  await saveNotificationPrefs({ sessionReminders: true, waitlistAlerts: true });
  try {
    await ensureNotificationPermission();
  } catch {
    /* native permission prompt unsupported/denied — continue anyway */
  }
  await Promise.all([syncExpoPushTokenIfNeeded(), syncWebPushSubscriptionIfNeeded()]);
}

/** Does the current user have a manager-queued activation prompt waiting? */
export async function fetchPendingNotificationPrompt(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("notification_prompt_queued_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { notification_prompt_queued_at: string | null }).notification_prompt_queued_at != null;
}

/** Consumes the prompt (activated or skipped) so it doesn't show again from this batch. */
export async function clearPendingNotificationPrompt(userId: string): Promise<void> {
  await supabase.from("profiles").update({ notification_prompt_queued_at: null }).eq("user_id", userId);
}

/** Manager-only: flag every currently notifications-off real account to see the popup once. */
export async function queueNotificationActivationPrompt(): Promise<{ ok: boolean; queued?: number; error?: string }> {
  const { data, error } = await supabase.rpc("manager_queue_notification_activation_prompt");
  const res = data as { ok?: boolean; queued?: number; error?: string } | null;
  if (error) return { ok: false, error: error.message };
  if (!res?.ok) return { ok: false, error: res?.error };
  return { ok: true, queued: res.queued ?? 0 };
}
