import { useEffect } from "react";
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

  useEffect(() => {
    if (Platform.OS !== "web" || !session) return;
    if (!pathname || pathname === "/") return;
    const search = typeof window !== "undefined" ? window.location.search : "";
    saveWebLastRoute(`${pathname}${search}`);
  }, [pathname, session]);

  return null;
}
