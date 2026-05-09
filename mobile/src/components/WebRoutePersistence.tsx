import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { saveWebLastRoute } from "../lib/webLastRoute";

/**
 * Persists the current URL (path + query) on web so a later full reload that lands on `/`
 * can restore the last screen (see app/index.tsx). Browsers often reload background tabs.
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

  // Flush when the tab goes to background — usePathname may not run before the OS freezes the page.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || typeof window === "undefined") return;

    const flush = () => {
      if (!sessionRef.current) return;
      const path = window.location.pathname + window.location.search;
      saveWebLastRoute(path);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
