import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

/**
 * Connectivity as the browser reports it (navigator.onLine + online/offline events), plus a count of
 * loading placeholders on screen. Presentation only (Phase 5 / O): nothing here changes how requests
 * are sent or retried. Native has no connectivity signal installed, so it always reads as online.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

let offline = Platform.OS === "web" && typeof navigator !== "undefined" && navigator.onLine === false;
let placeholders = 0;

if (Platform.OS === "web" && typeof window !== "undefined") {
  const update = () => {
    const next = navigator.onLine === false;
    if (next !== offline) {
      offline = next;
      emit();
    }
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
}

/** True while the device reports no connection (web only). */
export function useIsOffline(): boolean {
  return useSyncExternalStore(subscribe, () => offline, () => false);
}

/** True while any loading placeholder (skeleton / LoadingState) is mounted. */
export function useLoadingPlaceholdersActive(): boolean {
  return useSyncExternalStore(subscribe, () => placeholders > 0, () => false);
}

/** Loading placeholders call this so the offline notice can say the page itself can't load. */
export function useRegisterLoadingPlaceholder(): void {
  useEffect(() => {
    placeholders += 1;
    if (placeholders === 1) emit();
    return () => {
      placeholders -= 1;
      if (placeholders === 0) emit();
    };
  }, []);
}

/** Test hook: reset module state. */
export function __resetNetworkStatusForTests(next: { offline?: boolean; placeholders?: number } = {}) {
  offline = next.offline ?? false;
  placeholders = next.placeholders ?? 0;
  emit();
}
