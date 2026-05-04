import { Platform } from "react-native";

const PREFIX = "dismissed_home_alerts_v1:";

function storageKey(userId: string) {
  return `${PREFIX}${userId}`;
}

async function storageGet(userId: string): Promise<string | null> {
  const k = storageKey(userId);
  if (Platform.OS === "web") {
    return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
  }
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  return SecureStore.getItemAsync(k);
}

async function storageSet(userId: string, value: string): Promise<void> {
  const k = storageKey(userId);
  if (Platform.OS === "web") {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, value);
    return;
  }
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  await SecureStore.setItemAsync(k, value);
}

export async function loadDismissedHomeAlertIds(userId: string): Promise<Set<string>> {
  try {
    const raw = await storageGet(userId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export async function dismissHomeAlert(userId: string, alertId: string): Promise<void> {
  const existing = await loadDismissedHomeAlertIds(userId);
  existing.add(alertId);
  await storageSet(userId, JSON.stringify([...existing]));
}

export function filterUndismissedAlerts<T extends { id: string }>(items: T[], dismissed: Set<string>): T[] {
  return items.filter((x) => !dismissed.has(x.id));
}
