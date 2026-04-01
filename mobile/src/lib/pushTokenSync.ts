import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { supabase } from "./supabase";
import { loadNotificationPrefs } from "./notificationPrefs";

/** Save Expo push token on device when notifications are enabled (for server-side waitlist push). */
export async function syncExpoPushTokenIfNeeded(): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const prefs = await loadNotificationPrefs();
  if (!prefs.sessionReminders && !prefs.waitlistAlerts) {
    await supabase.from("profiles").update({ expo_push_token: null }).eq("user_id", user.id);
    return;
  }

  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.status !== Notifications.PermissionStatus.GRANTED) return;

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const tokenRes = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = tokenRes.data;
    if (!token) return;
    await supabase.from("profiles").update({ expo_push_token: token }).eq("user_id", user.id);
  } catch {
    /* Web, simulator, or missing EAS project — ignore */
  }
}
