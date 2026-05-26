import { useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

/**
 * Height of the area visible above the software keyboard.
 * On mobile web uses visualViewport; elsewhere falls back to window height.
 */
export function useVisibleViewportHeight(): number {
  const { height: windowHeight } = useWindowDimensions();
  const [height, setHeight] = useState(windowHeight);

  useEffect(() => {
    setHeight(windowHeight);
  }, [windowHeight]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      setHeight(vv.height);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return height;
}
