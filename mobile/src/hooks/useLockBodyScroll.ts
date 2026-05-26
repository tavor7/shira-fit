import { useEffect } from "react";
import { Platform } from "react-native";

/** Prevent the page behind a modal from scrolling (mobile web). */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !locked) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}
