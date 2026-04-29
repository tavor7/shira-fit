import { ReactNode, useMemo } from "react";
import { Modal, Pressable, StyleProp, StyleSheet, View, ViewStyle, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";

type Variant = "popover" | "sheet";

type Props = {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  variant?: Variant;
  /** For sheet/popover card. */
  cardStyle?: StyleProp<ViewStyle>;
  /** Backdrop accessibility label for screen readers. */
  backdropAccessibilityLabel: string;
  /** Max height as a fraction of the window height (default depends on variant). */
  maxHeightPct?: number;
  /** Optional fixed width (used by popover menus). */
  width?: number;
  /** Additional backdrop style overrides. */
  backdropStyle?: StyleProp<ViewStyle>;
  animationType?: "fade" | "slide";
};

export function AppModal({
  visible,
  onClose,
  children,
  variant = "sheet",
  cardStyle,
  backdropAccessibilityLabel,
  maxHeightPct,
  width,
  backdropStyle,
  animationType,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const effectiveMaxHeightPct = maxHeightPct ?? (variant === "sheet" ? 0.8 : 0.88);
  const maxH = Math.max(
    220,
    Math.round(height * effectiveMaxHeightPct) - (variant === "sheet" ? insets.bottom : 0) - theme.spacing.md
  );

  const cardBase = useMemo(() => {
    const base: ViewStyle =
      variant === "sheet"
        ? {
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            borderRadius: 0,
          }
        : {
            borderRadius: theme.radius.lg,
          };
    return base;
  }, [variant]);

  return (
    <Modal visible={visible} transparent animationType={animationType ?? (variant === "sheet" ? "slide" : "fade")} onRequestClose={onClose}>
      <View style={[styles.backdrop, variant === "sheet" ? styles.backdropSheet : styles.backdropPopover, backdropStyle]}>
        {/* Separate overlay avoids nested <button> on react-native-web */}
        <Pressable
          style={styles.overlay}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={backdropAccessibilityLabel}
        />
        <View
          style={[
            styles.card,
            cardBase,
            variant === "sheet" ? styles.cardSheet : styles.cardPopover,
            { maxHeight: maxH },
            width ? { width } : null,
            cardStyle,
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  backdropPopover: {
    padding: theme.spacing.md,
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  backdropSheet: {
    justifyContent: "flex-end",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardPopover: {
    marginTop: theme.spacing.sm,
  },
  cardSheet: {
    width: "100%",
    borderBottomWidth: 0,
  },
});

