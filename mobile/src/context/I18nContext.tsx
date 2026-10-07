import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { I18nManager, Platform, StyleSheet, View } from "react-native";
import { translations, type LanguageCode } from "../i18n/translations";
import { useAuth } from "./AuthContext";
import {
  LANGUAGE_STORAGE_KEY_GLOBAL,
  languageStorageKeyForUser,
  parseStoredLanguage,
  readDeviceLanguageTags,
  readStoredLanguage,
  readStoredLanguageSyncWeb,
  resolveLanguage,
  writeStoredLanguage,
} from "../lib/languagePreference";
import { rowFlipFor } from "../lib/layoutDirection";

type I18nCtx = {
  language: LanguageCode;
  isRTL: boolean;
  /**
   * Apply manual `row-reverse` mirroring only when this is true (see lib/layoutDirection). Never on web,
   * where <html dir> already mirrors rows; on native, only while I18nManager disagrees with the language.
   */
  rowFlip: boolean;
  t: (key: string) => string;
  setLanguage: (lang: LanguageCode) => Promise<void>;
  toggleLanguage: () => Promise<void>;
};

const Ctx = createContext<I18nCtx | null>(null);

function isRtlLanguage(lang: LanguageCode) {
  return lang === "he";
}

/** Runs before paint on web so `lang`/`dir` never lag a language change; plain effect elsewhere. */
const useIsomorphicLayoutEffect = Platform.OS === "web" ? useLayoutEffect : useEffect;

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  // Web reads the saved choice synchronously, so the first render is already in the right language
  // (public/index.html has set the matching lang/dir before React mounted). Native starts from the
  // device language and applies the saved choice once SecureStore answers.
  const [language, setLanguageState] = useState<LanguageCode>(() =>
    resolveLanguage({
      globalStored: readStoredLanguageSyncWeb(LANGUAGE_STORAGE_KEY_GLOBAL),
      deviceTags: readDeviceLanguageTags(),
    })
  );

  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;
    void readStoredLanguage(LANGUAGE_STORAGE_KEY_GLOBAL).then((v) => {
      const saved = parseStoredLanguage(v);
      if (!cancelled && saved) setLanguageState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // A saved per-account choice wins over the device-level one on sign-in.
    void readStoredLanguage(languageStorageKeyForUser(userId)).then((v) => {
      const saved = parseStoredLanguage(v);
      if (!cancelled && saved) setLanguageState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const isRTL = isRtlLanguage(language);
  const rowFlip = rowFlipFor(isRTL);

  useIsomorphicLayoutEffect(() => {
    // - Web: <html lang dir> is the single source of layout direction (react-native-web's I18nManager is a no-op).
    // - Native: configure I18nManager. Some changes may require an app restart to fully apply.
    if (Platform.OS === "web") {
      try {
        if (typeof document !== "undefined") {
          document.documentElement.lang = language;
          document.documentElement.dir = isRTL ? "rtl" : "ltr";
        }
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
  }, [language, isRTL]);

  const t = useMemo(() => {
    const dict = translations[language] ?? translations.en;
    return (key: string) => dict[key] ?? translations.en[key] ?? key;
  }, [language]);

  async function setLanguage(lang: LanguageCode) {
    setLanguageState(lang);
    await writeStoredLanguage(LANGUAGE_STORAGE_KEY_GLOBAL, lang);
    if (userId) await writeStoredLanguage(languageStorageKeyForUser(userId), lang);
  }

  async function toggleLanguage() {
    await setLanguage(language === "he" ? "en" : "he");
  }

  return (
    <Ctx.Provider value={{ language, isRTL, rowFlip, t, setLanguage, toggleLanguage }}>
      {Platform.OS === "web" ? (
        // react-native-web resolves logical styles (marginStart, paddingEnd, borderStartWidth, start/end,
        // textAlign "start"/"end") from its own locale context, not from <html dir>; a View with `dir`
        // provides that context to the whole app. Native resolves them through I18nManager instead.
        <View style={styles.localeRoot} {...({ dir: isRTL ? "rtl" : "ltr", lang: language } as object)}>
          {children}
        </View>
      ) : (
        children
      )}
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  localeRoot: { flex: 1 },
});

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
