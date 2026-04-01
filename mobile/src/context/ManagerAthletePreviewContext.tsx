import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import type { Profile } from "../types/database";

const KEY = "manager_athlete_preview_v1";

function readWebSync(): boolean {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return false;
  return localStorage.getItem(KEY) === "1";
}

async function readNative(): Promise<boolean> {
  try {
    const SS = require("expo-secure-store") as typeof import("expo-secure-store");
    const v = await SS.getItemAsync(KEY);
    return v === "1";
  } catch {
    return false;
  }
}

async function persist(on: boolean): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
    return;
  }
  try {
    const SS = require("expo-secure-store") as typeof import("expo-secure-store");
    if (on) await SS.setItemAsync(KEY, "1");
    else await SS.deleteItemAsync(KEY).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

type Ctx = {
  /** True when a manager is browsing the app in athlete-style navigation. */
  enabled: boolean;
  setEnabled: (on: boolean) => Promise<void>;
  /** Native: false until SecureStore read finishes (avoid wrong home route on cold start). */
  storageReady: boolean;
};

const ManagerAthletePreviewCtx = createContext<Ctx | null>(null);

export function ManagerAthletePreviewProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState(readWebSync);
  const [storageReady, setStorageReady] = useState(Platform.OS === "web");

  useEffect(() => {
    if (Platform.OS === "web") return;
    void readNative().then((v) => {
      setEnabledState(v);
      setStorageReady(true);
    });
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    setEnabledState(on);
    await persist(on);
  }, []);

  const value = useMemo(() => ({ enabled, setEnabled, storageReady }), [enabled, setEnabled, storageReady]);

  return <ManagerAthletePreviewCtx.Provider value={value}>{children}</ManagerAthletePreviewCtx.Provider>;
}

export function useManagerAthletePreview() {
  const v = useContext(ManagerAthletePreviewCtx);
  if (!v) throw new Error("useManagerAthletePreview outside ManagerAthletePreviewProvider");
  return v;
}

/** Role used for home redirect and quick menu (manager + preview → athlete). */
export function useEffectiveNavRole(profile: Profile | null | undefined): string {
  const { enabled } = useManagerAthletePreview();
  if (!profile?.role) return "";
  if (profile.role === "manager" && enabled) return "athlete";
  return profile.role;
}
