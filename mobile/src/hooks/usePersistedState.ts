import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

const DEFAULT_DEBOUNCE_MS = 400;

const DEBUG_PERSIST = __DEV__;

function persistLog(phase: string, payload: Record<string, unknown>) {
  if (!DEBUG_PERSIST) return;
  try {
    // eslint-disable-next-line no-console
    console.log(`[usePersistedState] ${phase}`, payload);
  } catch {
    /* ignore */
  }
}

type Options<T> = {
  debounceMs?: number;
  serialize?: (value: T) => string;
  deserialize?: (raw: string) => T;
  /**
   * If the primary key has no value, read this key (e.g. anon-scoped) and migrate to primary.
   */
  migrateFromKeyIfEmpty?: string;
};

function defaultSerialize<T>(value: T): string {
  return JSON.stringify(value);
}

function defaultDeserialize<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSetSyncWeb(key: string, value: string): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota */
  }
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    storageSetSyncWeb(key, value);
    return;
  }
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

async function storageRemove(key: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Persist JSON-serializable state to localStorage (web) or AsyncStorage (native).
 * Skips writes until hydration completes so empty initial state does not clobber storage.
 */
export function usePersistedState<T>(
  storageKey: string,
  initialValue: T,
  options?: Options<T>
): [
  T,
  React.Dispatch<React.SetStateAction<T>>,
  { hydrated: boolean; clearPersisted: () => Promise<void>; flush: () => Promise<void> },
] {
  const serialize = options?.serialize ?? defaultSerialize;
  const deserialize = options?.deserialize;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const migrateFromKeyIfEmpty = options?.migrateFromKeyIfEmpty;
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;

  const [state, setState] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSerializedRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  const flush = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingSerializedRef.current;
    if (pending !== null) {
      pendingSerializedRef.current = null;
      persistLog("flush", { key: storageKeyRef.current, len: pending.length });
      await storageSet(storageKeyRef.current, pending);
    }
  }, []);

  const flushSyncWeb = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingSerializedRef.current;
    if (pending === null) return;
    const key = storageKeyRef.current;
    persistLog("flushSyncWeb", { key, len: pending.length });
    storageSetSyncWeb(key, pending);
  }, []);

  const clearPersisted = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingSerializedRef.current = null;
    skipNextPersistRef.current = true;
    persistLog("clearPersisted", { key: storageKeyRef.current });
    await storageRemove(storageKeyRef.current);
    const init = initialRef.current;
    setState(init);
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
    setState(initialRef.current);
    let cancelled = false;

    void (async () => {
      let raw = await storageGet(storageKey);
      let usedMigrate = false;
      if ((!raw || raw === "") && migrateFromKeyIfEmpty && migrateFromKeyIfEmpty !== storageKey) {
        const alt = await storageGet(migrateFromKeyIfEmpty);
        if (alt != null && alt !== "") {
          raw = alt;
          usedMigrate = true;
          persistLog("hydrate_migrate_read", { from: migrateFromKeyIfEmpty, to: storageKey });
        }
      }
      if (cancelled) return;
      if (raw != null && raw !== "") {
        const parsed = deserialize ? deserialize(raw) : defaultDeserialize(raw, initialRef.current);
        persistLog("hydrate_read", {
          key: storageKey,
          usedMigrate,
          preview: raw.length > 220 ? `${raw.slice(0, 220)}…` : raw,
        });
        setState(parsed);
        if (usedMigrate && migrateFromKeyIfEmpty) {
          const fromKey = migrateFromKeyIfEmpty;
          if (Platform.OS === "web") {
            try {
              storageSetSyncWeb(storageKey, raw);
              if (typeof localStorage !== "undefined") localStorage.removeItem(fromKey);
            } catch {
              /* ignore */
            }
          } else {
            try {
              await storageSet(storageKey, raw);
              await storageRemove(fromKey);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        persistLog("hydrate_empty", { key: storageKey });
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey, deserialize, migrateFromKeyIfEmpty]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const ser = serialize(state);
    pendingSerializedRef.current = ser;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const p = pendingSerializedRef.current;
      if (p !== null) {
        persistLog("debounced_write", { key: storageKey, len: p.length });
        void storageSet(storageKey, p);
      }
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [state, storageKey, serialize, debounceMs]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const onHide = () => {
      persistLog("pagehide_or_hidden", { visibilityState: document.visibilityState });
      flushSyncWeb();
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onHide);

    return () => {
      document.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [flushSyncWeb]);

  return [state, setState, { hydrated, clearPersisted, flush }];
}
