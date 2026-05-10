import { Platform } from "react-native";

/** Single pagehide/visibility listener for all draft hooks (web only). */
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

function attachGlobalListenersOnce() {
  if (listenersAttached || Platform.OS !== "web" || typeof document === "undefined") return;
  listenersAttached = true;
  const onHide = () => runAllFlushers();
  const onVis = () => {
    if (document.visibilityState === "hidden") onHide();
  };
  document.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("beforeunload", onHide);
}

/** Register a synchronous flush callback; returns unregister. */
export function registerWebDraftFlusher(fn: () => void): () => void {
  if (Platform.OS !== "web") return () => undefined;
  flushers.add(fn);
  attachGlobalListenersOnce();
  return () => {
    flushers.delete(fn);
  };
}
