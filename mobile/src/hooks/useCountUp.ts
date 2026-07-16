import { useEffect, useRef, useState } from "react";
import { Easing } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "./useReduceMotion";

/** Tweens from the currently displayed value to `target` whenever it changes (not always from 0). */
export function useCountUp(target: number, duration: number = theme.motion.normal): number {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    const from = displayedRef.current;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (from === target || reduceMotionRef.current) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const start = Date.now();
    const easing = Easing.out(Easing.cubic);
    const tick = () => {
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / duration);
      const value = from + (target - from) * easing(t);
      displayedRef.current = value;
      setDisplayed(value);
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return displayed;
}
