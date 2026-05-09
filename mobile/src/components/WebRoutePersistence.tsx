import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { saveWebLastRoute } from "../lib/webLastRoute";

/**
 * Persists the current URL (path + query) on web so a later full reload that lands on `/`
 * can restore the last screen (see app/index.tsx). Lives in root `_layout` so `pagehide` runs for
 * every route — not only inside `/(app)`.
 */
export function WebRoutePersistence() {
  const pathname = usePathname() ?? "";
  const { session } = useAuth();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (Platform.OS !== "web" || !session) return;
    if (!pathname || pathname === "/") return;
    const search = typeof window !== "undefined" ? window.location.search : "";
    saveWebLastRoute(`${pathname}${search}`);
  }, [pathname, session]);

  // Flush whenever the tab might die — do not require session (refs can be stale on freeze).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || typeof window === "undefined") return;

    const flush = () => {
      const path = window.location.pathname + window.location.search;
      saveWebLastRoute(path);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
