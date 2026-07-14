import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

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
  const isPopover = variant === "popover";

  // Popover gets its own scale+fade animation (menu "pop"); sheet/dialog keep the native
  // Modal animationType, which already looks right for those (slide-up / center-fade).
  const [popoverMounted, setPopoverMounted] = useState(visible);
  const popoverProgress = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (!isPopover) return;
    if (visible) {
      setPopoverMounted(true);
      Animated.timing(popoverProgress, {
        toValue: 1,
        duration: reduceMotionRef.current ? 0 : theme.motion.normal,
        easing: Easing.out(Easing.back(1.15)),
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(popoverProgress, {
        toValue: 0,
        duration: reduceMotionRef.current ? 0 : theme.motion.fast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setPopoverMounted(false));
    }
  }, [visible, isPopover, popoverProgress, reduceMotionRef]);

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

  const cardContentStyle = [
    styles.card,
    cardBase,
    variant === "sheet" ? styles.cardSheet : isDialog ? styles.cardDialog : styles.cardPopover,
    { maxHeight: maxH },
    isDialog ? { width: dialogWidth } : width && !popoverPos ? { width } : null,
    popoverPos
      ? {
          position: "absolute" as const,
          top: popoverPos.top,
          left: popoverPos.left,
          width: popoverPos.width,
          marginTop: 0,
        }
      : null,
    cardStyle,
  ];

  return (
    <Modal
      visible={isPopover ? popoverMounted : visible}
      transparent
      animationType={isPopover ? "none" : (animationType ?? (variant === "sheet" ? "slide" : "fade"))}
      onRequestClose={onClose}
    >
      <Animated.View
        style={[
          styles.backdrop,
          variant === "sheet" ? styles.backdropSheet : isDialog ? styles.backdropDialog : styles.backdropPopover,
          isPopover ? { opacity: popoverProgress } : null,
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
        {isPopover ? (
          <Animated.View
            style={[
              ...cardContentStyle,
              {
                opacity: popoverProgress,
                transform: [
                  { scale: popoverProgress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
                  { translateY: popoverProgress.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
                ],
              },
            ]}
          >
            {children}
          </Animated.View>
        ) : (
          <View style={cardContentStyle}>{children}</View>
        )}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.overlay.backdrop,
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

