import { useEffect, useRef } from "react";
import { Platform } from "react-native";

/** How often to poll for a new deployed build while the tab is open. */
const CHECK_INTERVAL_MS = 45_000;

function extractBundleFile(html: string): string | null {
  const m = html.match(/_expo\/static\/js\/web\/([^"'\s]+\.js)/);
  return m?.[1] ?? null;
}

function currentBundleFile(): string | null {
  const script = document.querySelector('script[src*="_expo/static/js/web/"]');
  const src = script?.getAttribute("src") ?? "";
  return extractBundleFile(src);
}

/**
 * Web only, no-op on native (native has its own OTA update check via expo-updates).
 *
 * `expo export` embeds a content hash in the bundle filename referenced from `index.html`, so a
 * new deploy always ships a new script src. This periodically re-fetches `index.html` (also on
 * tab focus, since mobile browsers throttle background timers) and reloads the page once the
 * hash no longer matches what's currently running — so an already-open tab picks up a fresh
 * deploy on its own instead of needing a manual pull-to-refresh.
 */
export function useWebLiveReload() {
  const initialFileRef = useRef<string | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    // Dev already has Fast Refresh via the Metro/webpack dev server — this is only for a
    // deployed static build, where an already-open tab has no other way to learn about a
    // new deploy.
    if (__DEV__ || Platform.OS !== "web" || typeof document === "undefined") return;
    initialFileRef.current = currentBundleFile();
    if (!initialFileRef.current) return;

    async function check() {
      if (reloadingRef.current) return;
      try {
        const res = await fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const latest = extractBundleFile(await res.text());
        if (latest && initialFileRef.current && latest !== initialFileRef.current) {
          reloadingRef.current = true;
          window.location.reload();
        }
      } catch {
        // offline or request blocked — just try again on the next tick
      }
    }

    const interval = setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
}
