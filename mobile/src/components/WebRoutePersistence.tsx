import { useEffect } from "react";
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

    // pagehide + visibility:hidden track tab/app switch. Avoid window "blur" — it can fire during
    // in-page focus moves and overwrote localStorage with a stale URL while pathname already moved.
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
