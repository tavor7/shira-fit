import { useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

export type VisualViewportRect = {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
};

/**
 * Tracks the browser visual viewport (area above the software keyboard on mobile web).
 * On native, returns the full window with zero offset.
 */
export function useVisualViewport(): VisualViewportRect {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [rect, setRect] = useState<VisualViewportRect>({
    height: windowHeight,
    width: windowWidth,
    offsetTop: 0,
    offsetLeft: 0,
  });

  useEffect(() => {
    setRect((prev) =>
      prev.height === windowHeight && prev.width === windowWidth ? prev : { ...prev, height: windowHeight, width: windowWidth }
    );
  }, [windowHeight, windowWidth]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const update = () => {
      const vv = window.visualViewport;
      setRect({
        height: vv?.height ?? window.innerHeight,
        width: vv?.width ?? window.innerWidth,
        offsetTop: vv?.offsetTop ?? 0,
        offsetLeft: vv?.offsetLeft ?? 0,
      });
    };

    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);

    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return rect;
}
