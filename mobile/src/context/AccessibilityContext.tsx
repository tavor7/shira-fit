import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";

export type AccessibilityPrefs = {
  textScale: 1 | 1.15 | 1.3;
  highContrast: boolean;
  enhancedFocus: boolean;
  reduceMotion: boolean;
  underlineLinks: boolean;
};

const DEFAULT_PREFS: AccessibilityPrefs = {
  textScale: 1,
  highContrast: false,
  enhancedFocus: false,
  reduceMotion: false,
  underlineLinks: false,
};

const STORAGE_KEY = "shirafit_a11y_prefs_v1";

type Ctx = {
  prefs: AccessibilityPrefs;
  setPrefs: (next: Partial<AccessibilityPrefs>) => void;
  reset: () => void;
};

const AccessibilityCtx = createContext<Ctx>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  reset: () => {},
});

function loadStored(): AccessibilityPrefs {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<AccessibilityPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Web-only accessibility preferences (text size, contrast, focus, motion, links), persisted per-device. */
export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<AccessibilityPrefs>(() => loadStored());

  useEffect(() => {
    if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* private-mode / storage blocked — preference just won't persist */
    }
  }, [prefs]);

  const value = useMemo<Ctx>(
    () => ({
      prefs,
      setPrefs: (next) => setPrefsState((s) => ({ ...s, ...next })),
      reset: () => setPrefsState(DEFAULT_PREFS),
    }),
    [prefs]
  );

  return <AccessibilityCtx.Provider value={value}>{children}</AccessibilityCtx.Provider>;
}

export function useAccessibilityPrefs(): Ctx {
  return useContext(AccessibilityCtx);
}
