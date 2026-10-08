import { useCallback, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { theme } from "../theme";
import { rowFlipFor } from "../lib/layoutDirection";

/**
 * Tracks whether a horizontal ScrollView has hidden content before or after the visible part,
 * in reading order (start = where a line of text begins, so the right edge in Hebrew).
 */
export function useHorizontalOverflow(isRTL: boolean) {
  const view = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    const max = content.current - view.current;
    if (max <= 1) {
      setEdges((e) => (e.start || e.end ? { start: false, end: false } : e));
      return;
    }
    // Distance scrolled from the reading-order start. The browser-mirrored (web RTL) scroller reports a
    // negative offset; a manually reversed row (native RTL) starts scrolled to its far end.
    const raw = offset.current;
    const fromStart = Platform.OS === "web" ? Math.abs(raw) : rowFlipFor(isRTL) ? max - raw : raw;
    const next = { start: fromStart > 2, end: fromStart < max - 2 };
    setEdges((e) => (e.start === next.start && e.end === next.end ? e : next));
  }, [isRTL]);

  return {
    edges,
    scrollProps: {
      onLayout: (e: LayoutChangeEvent) => {
        view.current = e.nativeEvent.layout.width;
        update();
      },
      onContentSizeChange: (w: number) => {
        content.current = w;
        update();
      },
      onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.x;
        update();
      },
      scrollEventThrottle: 32,
    },
  };
}

const STEPS = [0.15, 0.4, 0.65, 0.88];

/** A soft fade over the edge of a horizontal scroller, signalling that more content continues that way. */
export function EdgeFade({
  side,
  visible,
  isRTL,
  color = theme.colors.backgroundAlt,
  width = 28,
}: {
  side: "start" | "end";
  visible: boolean;
  isRTL: boolean;
  color?: string;
  width?: number;
}) {
  if (!visible) return null;
  // Strips get more opaque towards the edge; rows follow the reading direction (reversed manually on native RTL).
  const strips = side === "end" ? STEPS : [...STEPS].reverse();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.fade,
        { width },
        side === "start" ? { start: 0 } : { end: 0 },
        rowFlipFor(isRTL) && styles.flip,
      ]}
    >
      {strips.map((o, i) => (
        <View key={i} style={[styles.strip, { backgroundColor: color, opacity: o }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", top: 0, bottom: 0, flexDirection: "row" },
  flip: { flexDirection: "row-reverse" },
  strip: { flex: 1 },
});
