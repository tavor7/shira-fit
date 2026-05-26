import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** Bottom inset (px) when the software keyboard is open (best-effort on web). */
type VisualViewport = {
  height: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === "web") {
      // RN Web: the "software keyboard" isn't reported by `Keyboard` events.
      // Instead, we approximate it using the Visual Viewport height (when available).
      if (typeof window === "undefined") return;

      const vv = (window as any).visualViewport as VisualViewport | undefined;
      if (!vv) return;

      const compute = () => {
        const innerH = window.innerHeight || document.documentElement.clientHeight || 0;
        const vvH = vv.height || innerH;
        const offsetTop = (vv as { offsetTop?: number }).offsetTop ?? 0;
        // Clamp to avoid extreme UI chrome changes shrinking the sheet too much.
        const next = Math.max(0, innerH - vvH - offsetTop);
        setInset(Math.min(next, 600));
      };

      compute();
      vv.addEventListener("resize", compute);
      window.addEventListener("resize", compute);
      return () => {
        vv.removeEventListener("resize", compute);
        window.removeEventListener("resize", compute);
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
