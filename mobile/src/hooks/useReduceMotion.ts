import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";

/** Ref (not state) so animation callbacks can read the latest value without re-subscribing. */
export function useReduceMotionRef() {
  const ref = useRef(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      ref.current = v;
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => {
      ref.current = v;
    });
    return () => sub.remove();
  }, []);
  return ref;
}
