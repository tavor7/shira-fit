import { Platform } from "react-native";

/**
 * Performance instrumentation switch (docs/performance/README.md). OFF unless explicitly enabled on this device:
 * web only, via `localStorage.sf_perf === "1"` (set from the browser console / Safari Web Inspector) or by opening any
 * app URL once with `?sf_perf=1` (`?sf_perf=0` turns it off again). Native builds never enable it.
 *
 * Read once and cached: a disabled app pays one boolean check per instrumented call and nothing else.
 */
export const PERF_STORAGE_KEY = "sf_perf";

let enabled: boolean | null = null;

function readWebFlag(): boolean {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
    const param = new URLSearchParams(window.location?.search ?? "").get(PERF_STORAGE_KEY);
    if (param === "1") localStorage.setItem(PERF_STORAGE_KEY, "1");
    else if (param === "0") localStorage.removeItem(PERF_STORAGE_KEY);
    return localStorage.getItem(PERF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isPerfEnabled(): boolean {
  if (enabled === null) enabled = Platform.OS === "web" ? readWebFlag() : false;
  return enabled;
}

/** Tests only. `null` re-reads the flag on the next call. */
export function setPerfEnabledForTests(value: boolean | null): void {
  enabled = value;
}
