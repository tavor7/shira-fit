import { useCallback, useEffect, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { isPerfEnabled } from "../lib/perf/perfFlag";
import { perfBeginVisit, perfSetReady } from "../lib/perf/perfStore";

/**
 * Performance instrumentation for one screen (docs/performance/README.md): records each focus as a visit and when the
 * screen's meaningful content is showing. `ready` must be false exactly while the screen shows a loading state in place
 * of its content (skeleton, spinner). No-op unless instrumentation is enabled on this device.
 */
export function usePerfScreen(screen: string, ready: boolean): void {
  const visitRef = useRef<number | null>(null);
  const readyRef = useRef(ready);

  // Declared before the focus effect so the focus callback reads this render's value.
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useFocusEffect(
    useCallback(() => {
      if (!isPerfEnabled()) return;
      visitRef.current = perfBeginVisit(screen, readyRef.current);
    }, [screen])
  );

  useEffect(() => {
    if (!isPerfEnabled()) return;
    perfSetReady(visitRef.current, ready);
  }, [ready]);
}
