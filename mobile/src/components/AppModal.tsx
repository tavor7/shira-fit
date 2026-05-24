import { ReactNode, useMemo } from "react";
import { Modal, Pressable, StyleProp, StyleSheet, View, ViewStyle, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";

type Variant = "popover" | "sheet" | "dialog";

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
  /** Anchor popover near a trigger (screen coordinates from measureInWindow). */
  anchorRect?: { x: number; y: number; width: number; height: number };
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
  anchorRect,
  backdropStyle,
  animationType,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height, width: screenW } = useWindowDimensions();

  const isDialog = variant === "dialog";
  const effectiveMaxHeightPct = maxHeightPct ?? (variant === "sheet" ? 0.8 : isDialog ? 0.85 : 0.88);
  const maxH = Math.max(
    220,
    Math.round(height * effectiveMaxHeightPct) -
      (variant === "sheet" ? insets.bottom : isDialog ? theme.spacing.lg * 2 : 0) -
      theme.spacing.md
  );

  const dialogWidth = useMemo(() => {
    if (!isDialog) return width;
    const maxW = Math.min(screenW - theme.spacing.lg * 2, 440);
    return width ?? maxW;
  }, [isDialog, screenW, width]);

  const cardBase = useMemo(() => {
    if (variant === "sheet") {
      return {
        borderTopLeftRadius: theme.radius.xl,
        borderTopRightRadius: theme.radius.xl,
        borderRadius: 0,
      };
    }
    if (variant === "dialog") {
      return { borderRadius: theme.radius.xl };
    }
    return { borderRadius: theme.radius.lg };
  }, [variant]);

  const popoverPos = useMemo(() => {
    if (!anchorRect || variant !== "popover") return null;
    const cardW = width ?? 200;
    const gap = 4;
    const top = Math.min(anchorRect.y + anchorRect.height + gap, height - 120);
    let left = anchorRect.x + anchorRect.width - cardW;
    left = Math.max(8, Math.min(left, screenW - cardW - 8));
    return { top, left, width: cardW };
  }, [anchorRect, variant, width, height, screenW]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType={animationType ?? (variant === "sheet" ? "slide" : "fade")}
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.backdrop,
          variant === "sheet" ? styles.backdropSheet : isDialog ? styles.backdropDialog : styles.backdropPopover,
          backdropStyle,
        ]}
      >
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
            variant === "sheet" ? styles.cardSheet : isDialog ? styles.cardDialog : styles.cardPopover,
            { maxHeight: maxH },
            isDialog ? { width: dialogWidth } : width && !popoverPos ? { width } : null,
            popoverPos
              ? {
                  position: "absolute",
                  top: popoverPos.top,
                  left: popoverPos.left,
                  width: popoverPos.width,
                  marginTop: 0,
                }
              : null,
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
    padding: 0,
  },
  backdropDialog: {
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.lg,
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
  cardDialog: {
    width: "100%",
    maxWidth: 440,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  cardSheet: {
    width: "100%",
    borderBottomWidth: 0,
  },
});

