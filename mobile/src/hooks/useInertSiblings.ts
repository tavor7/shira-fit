import { useEffect, type RefObject } from "react";
import { Platform } from "react-native";

/**
 * Web: while `active`, mark every sibling of the overlay element `inert`, so keyboard and
 * screen-reader users cannot reach the screen behind an in-layout blocking overlay (the
 * legal / receipt gates). Global chrome outside the parent (accessibility button, footer)
 * and screens pushed above the layout stay usable. No effect on native.
 */
export function useInertSiblings(ref: RefObject<unknown>, active: boolean) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !active) return;
    const el = ref.current as HTMLElement | null;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const marked: HTMLElement[] = [];
    for (const sib of Array.from(parent.children)) {
      if (sib === el || !(sib instanceof HTMLElement) || sib.hasAttribute("inert")) continue;
      sib.setAttribute("inert", "");
      marked.push(sib);
    }
    return () => {
      for (const sib of marked) sib.removeAttribute("inert");
    };
  }, [ref, active]);
}
