import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Platform } from "react-native";
import { registerWebDraftFlusher } from "../lib/webDraftGlobalFlush";

/** Local draft persistence logs. Default off; no console noise or extra work when false. */
export const DEBUG_DRAFTS = false;

const DEFAULT_DEBOUNCE_MS = 400;

function draftLog(phase: string, payload: Record<string, unknown>) {
  if (!DEBUG_DRAFTS) return;
  try {
    // eslint-disable-next-line no-console
    console.log(`[draft] ${phase}`, payload);
  } catch {
    /* ignore */
  }
}

type Options<T> = {
  debounceMs?: number;
  serialize?: (value: T) => string;
  deserialize?: (raw: string) => T;
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
 * Hydrate once per `storageKey`, **debounced** writes (default 400ms) to limit localStorage/AsyncStorage churn
 * while typing, plus a single shared web `pagehide`/`visibilitychange`/`beforeunload` flush via `webDraftGlobalFlush`.
 */
export function usePersistedState<T>(
  storageKey: string,
  initialValue: T,
  options?: Options<T>
): [
  T,
  Dispatch<SetStateAction<T>>,
  { hydrated: boolean; clearPersisted: () => Promise<void>; flush: () => Promise<void> },
] {
  const serialize = options?.serialize ?? defaultSerialize;
  const deserializeOpt = options?.deserialize;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;
  const deserializeRef = useRef(deserializeOpt);
  deserializeRef.current = deserializeOpt;

  const [state, setState] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSerializedRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const lastCommittedSerRef = useRef<string | null>(null);
  /** After clearPersisted: do not write the initial snapshot back to disk until user edits. */
  const suppressInitialPersistAfterClearRef = useRef(false);

  const flushSyncWebInstance = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingSerializedRef.current;
    if (pending === null) return;
    const key = storageKeyRef.current;
    draftLog("flushSync", { key, len: pending.length });
    storageSetSyncWeb(key, pending);
    lastCommittedSerRef.current = pending;
  }, []);

  useEffect(() => {
    const unregister = registerWebDraftFlusher(flushSyncWebInstance);
    return unregister;
  }, [flushSyncWebInstance]);

  const flush = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingSerializedRef.current;
    if (pending !== null) {
      pendingSerializedRef.current = null;
      draftLog("flush", { key: storageKeyRef.current, len: pending.length });
      await storageSet(storageKeyRef.current, pending);
      lastCommittedSerRef.current = pending;
    }
  }, []);

  const clearPersisted = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingSerializedRef.current = null;
    skipNextPersistRef.current = true;
    suppressInitialPersistAfterClearRef.current = true;
    lastCommittedSerRef.current = null;
    draftLog("clear", { key: storageKeyRef.current });
    await storageRemove(storageKeyRef.current);
    setState(initialRef.current);
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
    setState(initialRef.current);
    lastCommittedSerRef.current = null;
    let cancelled = false;

    void (async () => {
      const raw = await storageGet(storageKey);
      if (cancelled) return;
      if (raw != null && raw !== "") {
        const des = deserializeRef.current;
        const parsed = des ? des(raw) : defaultDeserialize(raw, initialRef.current);
        const canon = serializeRef.current(parsed);
        draftLog("hydrate", { key: storageKey, len: raw.length });
        setState(parsed);
        lastCommittedSerRef.current = canon;
      } else {
        draftLog("hydrate_miss", { key: storageKey });
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const ser = serializeRef.current(state);
    if (suppressInitialPersistAfterClearRef.current) {
      const ini = serializeRef.current(initialRef.current);
      if (ser === ini) {
        return;
      }
      suppressInitialPersistAfterClearRef.current = false;
    }
    if (ser === lastCommittedSerRef.current) {
      pendingSerializedRef.current = ser;
      return;
    }
    pendingSerializedRef.current = ser;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const p = pendingSerializedRef.current;
      if (p !== null && p !== lastCommittedSerRef.current) {
        draftLog("write", { key: storageKey, len: p.length });
        void storageSet(storageKey, p).then(() => {
          lastCommittedSerRef.current = p;
        });
      }
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [state, storageKey, debounceMs]);

  return [state, setState, { hydrated, clearPersisted, flush }];
}
