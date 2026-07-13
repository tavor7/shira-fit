import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

const ITEM_HEIGHT = 44;
const VISIBLE_ROWS = 3;
const WHEEL_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;

let webScrollbarStyleInjected = false;

function ensureWebScrollbarHidden() {
  if (Platform.OS !== "web" || webScrollbarStyleInjected || typeof document === "undefined") return;
  webScrollbarStyleInjected = true;
  const style = document.createElement("style");
  style.textContent =
    ".wheel-picker-scroll::-webkit-scrollbar{display:none;width:0;height:0}.wheel-picker-scroll{scrollbar-width:none;-ms-overflow-style:none}";
  document.head.appendChild(style);
}

export type NumberScrollFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly number[];
  formatOption?: (n: number, language: string) => string;
};

export function NumberScrollField({ label, value, onChange, options, formatOption }: NumberScrollFieldProps) {
  const { isRTL, language } = useI18n();
  const scrollRef = useRef<ScrollView>(null);
  const lastEmittedIndexRef = useRef(0);
  const parsed = parseInt(String(value ?? "").trim(), 10);

  const selectedIndex = useMemo(() => {
    const idx = options.indexOf(Number.isFinite(parsed) ? parsed : options[0]!);
    return idx >= 0 ? idx : 0;
  }, [parsed, options]);

  const [focusedIndex, setFocusedIndex] = useState(selectedIndex);

  useEffect(() => {
    ensureWebScrollbarHidden();
  }, []);

  useEffect(() => {
    setFocusedIndex(selectedIndex);
    lastEmittedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: selectedIndex * ITEM_HEIGHT, animated: false });
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedIndex]);

  function indexFromOffset(y: number) {
    return Math.max(0, Math.min(options.length - 1, Math.round(y / ITEM_HEIGHT)));
  }

  function emitIndex(i: number) {
    const clamped = Math.max(0, Math.min(options.length - 1, i));
    setFocusedIndex(clamped);
    if (clamped === lastEmittedIndexRef.current) return;
    lastEmittedIndexRef.current = clamped;
    onChange(String(options[clamped]!));
  }

  function snapToIndex(i: number) {
    const y = i * ITEM_HEIGHT;
    scrollRef.current?.scrollTo({ y, animated: false });
    emitIndex(i);
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    emitIndex(indexFromOffset(e.nativeEvent.contentOffset.y));
  }

  function onScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    snapToIndex(indexFromOffset(e.nativeEvent.contentOffset.y));
  }

  const padY = (WHEEL_HEIGHT - ITEM_HEIGHT) / 2;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtl]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.frame}>
        <View style={styles.selectionBand} pointerEvents="none" />
        <View style={styles.fadeTop} pointerEvents="none" />
        <View style={styles.fadeBottom} pointerEvents="none" />
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={ITEM_HEIGHT}
          decelerationRate="fast"
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingVertical: padY }}
          onScroll={onScroll}
          onMomentumScrollEnd={onScrollEnd}
          onScrollEndDrag={onScrollEnd}
          className={Platform.OS === "web" ? "wheel-picker-scroll" : undefined}
          style={styles.scroll}
        >
          {options.map((n, index) => {
            const active = index === focusedIndex;
            return (
              <View key={n} style={styles.item}>
                <Text style={[styles.itemTxt, active && styles.itemTxtActive, isRTL && styles.rtl]} numberOfLines={1}>
                  {formatOption ? formatOption(n, language) : String(n)}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 0 },
  label: {
    marginBottom: 8,
    fontWeight: "700",
    color: theme.colors.textMuted,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  rtl: { textAlign: "center" },
  frame: {
    height: WHEEL_HEIGHT,
    borderRadius: theme.radius.sm,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  scroll: { flex: 1 },
  selectionBand: {
    position: "absolute",
    left: 6,
    right: 6,
    top: (WHEEL_HEIGHT - ITEM_HEIGHT) / 2,
    height: ITEM_HEIGHT,
    borderRadius: theme.radius.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    zIndex: 2,
  },
  fadeTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 30,
    backgroundColor: theme.colors.surfaceElevated,
    opacity: 0.82,
    zIndex: 3,
  },
  fadeBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 30,
    backgroundColor: theme.colors.surfaceElevated,
    opacity: 0.82,
    zIndex: 3,
  },
  item: {
    height: ITEM_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  itemTxt: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.textSoft,
    fontVariant: ["tabular-nums"],
  },
  itemTxtActive: {
    fontSize: 20,
    fontWeight: "900",
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
});
