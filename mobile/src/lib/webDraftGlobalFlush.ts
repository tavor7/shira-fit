import { Platform } from "react-native";

/** Single pagehide/visibility/beforeunload listener set for all draft hooks (web only). */
const flushers = new Set<() => void>();
let listenersAttached = false;

function runAllFlushers() {
  for (const fn of flushers) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function onPageHideOrBeforeUnload() {
  runAllFlushers();
}

function onVisibilityChange() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    runAllFlushers();
  }
}

function attachGlobalListeners() {
  if (listenersAttached || Platform.OS !== "web" || typeof document === "undefined") return;
  listenersAttached = true;
  document.addEventListener("pagehide", onPageHideOrBeforeUnload);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onPageHideOrBeforeUnload);
  }
}

function detachGlobalListeners() {
  if (!listenersAttached || typeof document === "undefined") return;
  listenersAttached = false;
  document.removeEventListener("pagehide", onPageHideOrBeforeUnload);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", onPageHideOrBeforeUnload);
  }
}

/** Register a synchronous flush callback; returns unregister (removes listeners when last flusher unregisters). */
export function registerWebDraftFlusher(fn: () => void): () => void {
  if (Platform.OS !== "web") return () => undefined;
  flushers.add(fn);
  attachGlobalListeners();
  return () => {
    flushers.delete(fn);
    if (flushers.size === 0) detachGlobalListeners();
  };
}
