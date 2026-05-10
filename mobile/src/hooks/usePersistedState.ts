import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

const DEFAULT_DEBOUNCE_MS = 400;

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

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore quota */
    }
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
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;

  const [state, setState] = useState<T>(initialValue);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSerializedRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);

  const flush = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingSerializedRef.current;
    if (pending !== null) {
      pendingSerializedRef.current = null;
      await storageSet(storageKey, pending);
    }
  }, [storageKey]);

  const clearPersisted = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingSerializedRef.current = null;
    skipNextPersistRef.current = true;
    await storageRemove(storageKey);
    const init = initialRef.current;
    setState(init);
  }, [storageKey]);

  useEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
    setState(initialRef.current);
    let cancelled = false;

    void (async () => {
      const raw = await storageGet(storageKey);
      if (cancelled) return;
      if (raw != null && raw !== "") {
        const parsed = deserialize ? deserialize(raw) : defaultDeserialize(raw, initialRef.current);
        setState(parsed);
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey, deserialize]);

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
      if (p !== null) void storageSet(storageKey, p);
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [state, storageKey, serialize, debounceMs]);

  return [state, setState, { hydrated, clearPersisted, flush }];
}
