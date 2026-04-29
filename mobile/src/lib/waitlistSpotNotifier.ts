import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { supabase } from "./supabase";
import { formatISODateFull } from "./dateFormat";
import { loadNotificationPrefs } from "./notificationPrefs";
import { ensureNotificationPermission } from "./sessionReminders";
import { fetchActiveSignupCountsBySession } from "./sessionSignupCounts";

function key(sessionId: string) {
  return `waitlist_spot_notified:${sessionId}`;
}

export async function checkWaitlistSpotsAndNotify(language: "en" | "he"): Promise<void> {
  const prefs = await loadNotificationPrefs();
  if (!prefs.waitlistAlerts) return;
  const ok = await ensureNotificationPermission();
  if (!ok) return;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: waits } = await supabase.from("waitlist_requests").select("session_id").eq("user_id", user.id);
  const sessionIds = [...new Set((waits ?? []).map((w) => w.session_id))];
  const countsBySession = await fetchActiveSignupCountsBySession(sessionIds);

  for (const sid of sessionIds) {
    const { data: s } = await supabase
      .from("training_sessions")
      .select("id, max_participants, session_date, start_time, is_open_for_registration")
      .eq("id", sid)
      .maybeSingle();
    if (!s) continue;

    const n = countsBySession[sid] ?? 0;

    if (n < s.max_participants && s.is_open_for_registration) {
      const been = await SecureStore.getItemAsync(key(sid));
      if (been) continue;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: language === "he" ? "יתכן שיש מקום פנוי" : "A spot may be open",
          body:
            language === "he"
              ? `אימון ${formatISODateFull(s.session_date, language)} — ניתן לנסות להירשם.`
              : `Session ${formatISODateFull(s.session_date, language)} — you can try to register.`,
          data: { session_id: sid },
        },
        trigger: null,
      });
      await SecureStore.setItemAsync(key(sid), "1");
    }
  }
}

export async function clearWaitlistSpotFlag(sessionId: string): Promise<void> {
  await SecureStore.deleteItemAsync(key(sessionId)).catch(() => undefined);
}
