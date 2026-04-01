import { Platform } from "react-native";

const KEY = "notification_prefs_v1";

export type NotificationPrefs = {
  sessionReminders: boolean;
  waitlistAlerts: boolean;
};

const DEFAULTS: NotificationPrefs = {
  sessionReminders: true,
  waitlistAlerts: true,
};

/** SecureStore is not usable on Expo web; mirror supabase.ts auth storage. */
async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  }
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    return;
  }
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  await SecureStore.setItemAsync(key, value);
}

export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const raw = await storageGet(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      sessionReminders: parsed.sessionReminders !== false,
      waitlistAlerts: parsed.waitlistAlerts !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
  await storageSet(KEY, JSON.stringify(prefs));
}
