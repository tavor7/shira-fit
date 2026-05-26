import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** iOS accessory bar above the software keyboard (AutoFill, arrows). */
const WEB_ACCESSORY_BAR_PX = 52;

type VisualViewportLike = {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function measureWebKeyboardInset(layoutBaseline: number, focused: boolean): number {
  if (typeof window === "undefined") return 0;

  const vv = window.visualViewport as VisualViewportLike | undefined;
  let measured = 0;

  if (vv) {
    const layoutH = document.documentElement.clientHeight || window.innerHeight;
    const fromLayout = Math.max(0, layoutH - vv.height - (vv.offsetTop ?? 0));
    const fromBaseline = Math.max(0, layoutBaseline - vv.height - (vv.offsetTop ?? 0));
    measured = Math.max(fromLayout, fromBaseline);
  }

  if (measured > 40) {
    return Math.min(measured + WEB_ACCESSORY_BAR_PX, 600);
  }

  if (focused) {
    const h = layoutBaseline || window.innerHeight;
    return Math.min(Math.round(h * 0.42) + WEB_ACCESSORY_BAR_PX, 600);
  }

  return 0;
}

/** Bottom inset (px) when the software keyboard is open (best-effort on web). */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof window === "undefined") return;

      let layoutBaseline = window.innerHeight;
      let inputFocused = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const applyInset = (next: number) => {
        setInset((prev) => (prev === next ? prev : next));
      };

      const compute = () => {
        layoutBaseline = Math.max(layoutBaseline, window.innerHeight, document.documentElement.clientHeight);
        const next = measureWebKeyboardInset(layoutBaseline, inputFocused);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => applyInset(next), 60);
      };

      const onFocusIn = (e: FocusEvent) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
        inputFocused = true;
        layoutBaseline = Math.max(layoutBaseline, window.innerHeight);
        compute();
      };

      const onFocusOut = () => {
        inputFocused = false;
        setTimeout(compute, 150);
      };

      compute();
      const vv = window.visualViewport;
      vv?.addEventListener("resize", compute);
      window.addEventListener("resize", compute);
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);

      return () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        vv?.removeEventListener("resize", compute);
        window.removeEventListener("resize", compute);
        document.removeEventListener("focusin", onFocusIn);
        document.removeEventListener("focusout", onFocusOut);
      };
    }

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setInset(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setInset(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return inset;
}
