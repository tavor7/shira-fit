import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { LanguageCode } from "../i18n/translations";

/**
 * Device-level saved choice (written on every explicit language change).
 * `public/index.html` reads this same key before React renders to set the initial `lang`/`dir`;
 * keep the two in sync (guarded by languagePreference.test.ts).
 */
export const LANGUAGE_STORAGE_KEY_GLOBAL = "shira_fit_language";

/** Per-account saved choice. expo-secure-store keys allow only alphanumerics plus ".", "-", "_" — no ":". */
export function languageStorageKeyForUser(userId: string): string {
  return `shira_fit_language_${userId}`;
}

export function parseStoredLanguage(value: string | null | undefined): LanguageCode | null {
  return value === "he" || value === "en" ? value : null;
}

/** First Hebrew-or-English preference among the device's ordered language tags, if any. */
export function languageFromDeviceTags(tags: readonly (string | null | undefined)[]): LanguageCode | null {
  for (const tag of tags) {
    const primary = String(tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
    // "iw" is the legacy ISO code for Hebrew still reported by some Android/Java stacks.
    if (primary === "he" || primary === "iw") return "he";
    if (primary === "en") return "en";
  }
  return null;
}

/**
 * Saved user choice → saved device choice → device/browser language → English.
 * An explicit saved choice always wins over the device language.
 */
export function resolveLanguage(input: {
  userStored?: string | null;
  globalStored?: string | null;
  deviceTags?: readonly (string | null | undefined)[];
}): LanguageCode {
  return (
    parseStoredLanguage(input.userStored) ??
    parseStoredLanguage(input.globalStored) ??
    (languageFromDeviceTags(input.deviceTags ?? []) === "he" ? "he" : "en")
  );
}

/** Ordered device/browser language tags (best effort; never throws). */
export function readDeviceLanguageTags(): string[] {
  try {
    if (Platform.OS === "web" && typeof navigator !== "undefined") {
      const list = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
      return list.filter((x): x is string => typeof x === "string");
    }
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale ? [locale] : [];
  } catch {
    return [];
  }
}

/** Web only: synchronous read so the first render already uses the saved language. Null elsewhere / on failure. */
export function readStoredLanguageSyncWeb(key: string): string | null {
  if (Platform.OS !== "web") return null;
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** SecureStore is not usable on Expo web (its web build is an empty module), so web uses localStorage — as notificationPrefs / supabase auth storage do. */
export async function readStoredLanguage(key: string): Promise<string | null> {
  if (Platform.OS === "web") return readStoredLanguageSyncWeb(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function writeStoredLanguage(key: string, lang: LanguageCode): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, lang);
      return;
    }
    await SecureStore.setItemAsync(key, lang);
  } catch {
    // Storage unavailable (private mode, quota, disabled): the in-memory choice still applies this session.
  }
}
