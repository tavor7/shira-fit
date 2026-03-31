import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { I18nManager, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { translations, type LanguageCode } from "../i18n/translations";
import { useAuth } from "./AuthContext";

type I18nCtx = {
  language: LanguageCode;
  isRTL: boolean;
  t: (key: string) => string;
  setLanguage: (lang: LanguageCode) => Promise<void>;
  toggleLanguage: () => Promise<void>;
};

const STORAGE_KEY_GLOBAL = "shira_fit_language";

function userKey(userId: string) {
  return `shira_fit_language:${userId}`;
}

const Ctx = createContext<I18nCtx | null>(null);

function isRtlLanguage(lang: LanguageCode) {
  return lang === "he";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [language, setLanguageState] = useState<LanguageCode>("en");

  useEffect(() => {
    (async () => {
      try {
        // Default before login: English. If a prior selection exists on this device, use it.
        const v = await SecureStore.getItemAsync(STORAGE_KEY_GLOBAL);
        if (v === "en" || v === "he") setLanguageState(v);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        // If this user has a saved preference, apply it on login.
        const v = await SecureStore.getItemAsync(userKey(userId));
        if (v === "en" || v === "he") setLanguageState(v);
      } catch {
        // ignore
      }
    })();
  }, [userId]);

  const isRTL = isRtlLanguage(language);

  useEffect(() => {
    // Best-effort RTL support:
    // - On web: set <html dir="rtl|ltr">
    // - On native: configure I18nManager. Some changes may require app restart to fully apply.
    if (Platform.OS === "web") {
      try {
        if (typeof document !== "undefined") document.documentElement.dir = isRTL ? "rtl" : "ltr";
      } catch {
        // ignore
      }
      return;
    }
    try {
      I18nManager.allowRTL(true);
      if (I18nManager.isRTL !== isRTL) I18nManager.forceRTL(isRTL);
    } catch {
      // ignore
    }
  }, [isRTL]);

  const t = useMemo(() => {
    const dict = translations[language] ?? translations.en;
    return (key: string) => dict[key] ?? translations.en[key] ?? key;
  }, [language]);

  async function setLanguage(lang: LanguageCode) {
    setLanguageState(lang);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_GLOBAL, lang);
      if (userId) await SecureStore.setItemAsync(userKey(userId), lang);
    } catch {
      // ignore
    }
  }

  async function toggleLanguage() {
    await setLanguage(language === "he" ? "en" : "he");
  }

  return <Ctx.Provider value={{ language, isRTL, t, setLanguage, toggleLanguage }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

