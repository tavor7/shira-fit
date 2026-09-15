import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useAccessibilityPrefs } from "../context/AccessibilityContext";

/**
 * Effective reduced-motion signal = OS/browser-level `prefers-reduced-motion` (via
 * AccessibilityInfo) OR the manual override in the web accessibility menu
 * (AccessibilityContext — always false on native, since that menu is web-only). Combining
 * them here means every existing consumer of useReduceMotion/useReduceMotionRef picks up
 * the in-app toggle automatically, with no per-component changes needed.
 */

/** Ref (not state) so animation callbacks can read the latest value without re-subscribing. */
export function useReduceMotionRef() {
  const ref = useRef(false);
  const osRef = useRef(false);
  const { prefs } = useAccessibilityPrefs();

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      osRef.current = v;
      ref.current = v || prefs.reduceMotion;
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => {
      osRef.current = v;
      ref.current = v || prefs.reduceMotion;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ref.current = osRef.current || prefs.reduceMotion;
  }, [prefs.reduceMotion]);

  return ref;
}

/** State (triggers re-render) for components whose animation setup needs to react to the setting changing. */
export function useReduceMotion(): boolean {
  const [osReduceMotion, setOsReduceMotion] = useState(false);
  const { prefs } = useAccessibilityPrefs();

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setOsReduceMotion);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOsReduceMotion);
    return () => sub.remove();
  }, []);

  return osReduceMotion || prefs.reduceMotion;
}
