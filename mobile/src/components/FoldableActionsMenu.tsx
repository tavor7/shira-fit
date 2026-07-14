import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { theme } from "../theme";
import { ActionButton } from "./ActionButton";
import { AppModal } from "./AppModal";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

export type FoldableActionsMenuItem = {
  label: string;
  onPress: () => void;
  badgeCount?: number;
  /** Screen reader label; defaults to `label`. */
  accessibilityLabel?: string;
};

type Props = {
  /** Shown in the popover header and as the default trigger label when `renderTrigger` is omitted. */
  menuTitle: string;
  /** Announced for the header close (X) control; required when the close button is shown. */
  closeAccessibilityLabel: string;
  items: FoldableActionsMenuItem[];
  renderTrigger?: (open: () => void) => ReactNode;
  /** Announced for the full-screen dismiss layer (required for i18n). */
  backdropAccessibilityLabel: string;
  /** Hide the small header row (e.g. when using a custom trigger only). */
  hideHeader?: boolean;
  /** Hide the close (X) button in the header row. */
  hideCloseButton?: boolean;
  /** When the key changes (usually route change), close the menu to avoid blocking scroll. */
  closeOnKey?: string;
};

export function FoldableActionsMenu({
  menuTitle,
  closeAccessibilityLabel,
  items,
  renderTrigger,
  backdropAccessibilityLabel,
  hideHeader,
  hideCloseButton,
  closeOnKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const triggerRef = useRef<View>(null);
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(280, Math.max(200, Math.round(width * 0.78)));

  const safeItems = useMemo(() => items.filter((i) => i.label.trim().length > 0), [items]);

  const stagger = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  function openMenu() {
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, width: w, height: h });
      setOpen(true);
    });
  }

  useEffect(() => {
    // Close on navigation changes so the modal backdrop doesn't "freeze" the UI.
    setOpen(false);
  }, [closeOnKey]);

  useEffect(() => {
    if (!open) return;
    stagger.setValue(0);
    Animated.timing(stagger, {
      toValue: 1,
      duration: reduceMotionRef.current ? 0 : theme.motion.normal + 80,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, stagger, reduceMotionRef]);

  // Reveal items in a soft cascade rather than all at once; each item's slice of the
  // shared timeline is derived from its index so this needs one driver, not N.
  const n = Math.max(safeItems.length, 1);
  const staggerStep = Math.min(0.06, 0.5 / n);
  const staggerSpan = Math.max(0.35, 1 - (n - 1) * staggerStep);
  const itemAnimatedStyle = (index: number) => {
    const start = index * staggerStep;
    const end = Math.min(start + staggerSpan, 1);
    return {
      opacity: stagger.interpolate({ inputRange: [start, end], outputRange: [0, 1], extrapolate: "clamp" as const }),
      transform: [
        {
          translateY: stagger.interpolate({ inputRange: [start, end], outputRange: [10, 0], extrapolate: "clamp" as const }),
        },
      ],
    };
  };

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        {renderTrigger ? renderTrigger(openMenu) : <ActionButton label={menuTitle} onPress={openMenu} />}
      </View>
      <AppModal
        visible={open}
        onClose={() => setOpen(false)}
        variant="popover"
        width={cardWidth}
        anchorRect={anchor ?? undefined}
        backdropAccessibilityLabel={backdropAccessibilityLabel}
      >
        {!hideHeader ? (
          <View style={styles.cardHeader}>
            <Text style={styles.cardHeaderTxt} numberOfLines={1} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
              {menuTitle}
            </Text>
            {!hideCloseButton ? (
              <Pressable
                onPress={() => setOpen(false)}
                style={({ pressed }) => [styles.cardClose, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
                accessibilityLabel={closeAccessibilityLabel}
              >
                <Text style={styles.cardCloseTxt} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
                  ✕
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {safeItems.map((item, index) => (
          <Animated.View key={item.label} style={itemAnimatedStyle(index)}>
          <Pressable
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            onPress={() => {
              setOpen(false);
              item.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={item.accessibilityLabel ?? item.label}
          >
            <View style={styles.itemRow}>
              <Text style={styles.itemText} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
                {item.label}
              </Text>
              {item.badgeCount && item.badgeCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeTxt} maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
                    {item.badgeCount > 99 ? "99+" : String(item.badgeCount)}
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
          </Animated.View>
        ))}
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  cardHeaderTxt: { color: theme.colors.textMuted, fontWeight: "900", letterSpacing: 0.2, fontSize: 12, textTransform: "uppercase", maxWidth: "70%" },
  cardClose: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  cardCloseTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  item: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  itemRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  itemPressed: { backgroundColor: theme.colors.surfaceElevated },
  itemText: { color: theme.colors.text, fontWeight: "700", fontSize: 14, letterSpacing: 0.2 },
  badge: {
    minWidth: 22,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.error,
  },
  badgeTxt: { color: "#fff", fontWeight: "900", fontSize: 11, letterSpacing: 0.2 },
});
