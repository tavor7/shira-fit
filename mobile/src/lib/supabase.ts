import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * SecureStore is native-only; on web it breaks at runtime.
 * Web uses localStorage (fine for dev; use native builds for production auth storage).
 */
function createAuthStorage() {
  if (Platform.OS === "web") {
    return {
      getItem: (key: string) =>
        Promise.resolve(
          typeof localStorage !== "undefined" ? localStorage.getItem(key) : null
        ),
      setItem: (key: string, value: string) => {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
        return Promise.resolve();
      },
      removeItem: (key: string) => {
        if (typeof localStorage !== "undefined") localStorage.removeItem(key);
        return Promise.resolve();
      },
    };
  }
  // Native: lazy require so web bundle doesn't rely on SecureStore implementation
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  return {
    getItem: (key: string) => SecureStore.getItemAsync(key),
    setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
    removeItem: (key: string) => SecureStore.deleteItemAsync(key),
  };
}

const url =
  Constants.expoConfig?.extra?.supabaseUrl ??
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  "";
const key =
  Constants.expoConfig?.extra?.supabaseAnonKey ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  "";

export const supabaseUrl = url;
export const supabaseAnonKey = key;

/** Best-effort clear of persisted auth state (web/localStorage only). */
export function clearSupabaseAuthStorage() {
  if (Platform.OS !== "web") return;
  if (typeof localStorage === "undefined") return;
  try {
    // supabase-js stores a key like: sb-<project-ref>-auth-token
    // We wipe any supabase auth token keys to avoid refresh-token loops.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      if (k.includes("-auth-token") || k.startsWith("sb-")) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }
}

export const supabase = createClient(url, key, {
  auth: {
    storage: createAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    // Web: recovery links put tokens in hash; parsed on reset-password screen
    detectSessionInUrl: Platform.OS === "web",
  },
});
