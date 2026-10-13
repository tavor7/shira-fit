import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

/**
 * Re-runs `refetch` when the app returns to the foreground (installed PWA / tab resume), but only while `isActive()` (the screen is the
 * focused one) and only if the data is at least `minAgeMs` old, so a quick app switch causes no request. Returns `markFresh`, which the
 * caller invokes after every successful load. No timers, no polling.
 */
export function useRefetchOnResume(refetch: () => void, isActive: () => boolean, minAgeMs = 30_000): () => void {
  const last = useRef(0);
  const refetchRef = useRef(refetch);
  const activeRef = useRef(isActive);
  useEffect(() => {
    last.current = Date.now(); // the screen has just loaded
  }, []);
  useEffect(() => {
    refetchRef.current = refetch;
    activeRef.current = isActive;
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !activeRef.current()) return;
      if (Date.now() - last.current < minAgeMs) return;
      last.current = Date.now();
      refetchRef.current();
    });
    return () => sub.remove();
  }, [minAgeMs]);
  return useCallback(() => {
    last.current = Date.now();
  }, []);
}
