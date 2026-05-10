import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export const UI_DRAFT_VERSION = "v1";
export const UI_DRAFT_PREFIX = `shirafit:draft:${UI_DRAFT_VERSION}:`;

export function uiDraftStorageKey(userId: string | null | undefined, screenKey: string): string {
  const u = userId?.trim() || "anon";
  return `${UI_DRAFT_PREFIX}${u}:${screenKey}`;
}

/** Draft key when user id was still resolving; use with usePersistedState migrateFromKeyIfEmpty. */
export function uiDraftAnonMigrationKey(screenKey: string): string {
  return uiDraftStorageKey(null, screenKey);
}

function webRemoveKeysWithPrefix(prefix: string) {
  if (typeof localStorage === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/** Remove all UI draft keys for this user (call on logout). */
export async function clearAllUiDraftsForUser(userId: string | null | undefined): Promise<void> {
  const uid = userId?.trim();
  if (!uid) return;
  const prefix = `${UI_DRAFT_PREFIX}${uid}:`;
  if (Platform.OS === "web") {
    webRemoveKeysWithPrefix(prefix);
    return;
  }
  try {
    const all = await AsyncStorage.getAllKeys();
    const toRemove = all.filter((k) => k.startsWith(prefix));
    if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  } catch {
    /* ignore */
  }
}
