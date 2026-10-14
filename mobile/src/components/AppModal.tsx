import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LAYOUT, screenContentFrame } from "../lib/screenLayout";
import { modalMaxHeight, SHORT_WINDOW_HEIGHT } from "../lib/modalLayout";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { useWebBackDismiss } from "../lib/webBackDismiss";

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
  /**
   * Opt-in: render the children in an internal ScrollView so content taller than the card (short windows, landscape
   * phones, 400% zoom, large text) scrolls instead of being clipped. Leave off for children that manage their own
   * scrolling or fill the card (flex / FlatList): nesting a second scroll area would break those layouts.
   * `"short"`: for those self-scrolling bodies (pinned header + list), scroll the whole card only when the window is very short
   * (< SHORT_WINDOW_HEIGHT), so normal sizes keep their layout and a 320×200 window still reaches every control.
   */
  scrollContent?: boolean | "short";
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
  scrollContent,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height, width: screenW } = useWindowDimensions();
  // Web: browser Back closes this dialog before it leaves the page (Phase 5 / Q).
  useWebBackDismiss(visible, onClose);
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

  const dialogWidth = useMemo(() => {
    if (!isDialog) return width;
    const maxW = Math.min(screenW - theme.spacing.lg * 2 - insets.left - insets.right, 440);
    return width ?? maxW;
  }, [isDialog, screenW, width, insets.left, insets.right]);

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

  const maxH = modalMaxHeight({
    variant,
    windowHeight: height,
    pct: effectiveMaxHeightPct,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    dialogPadding: theme.spacing.lg,
    gap: theme.spacing.md,
    popoverTop: popoverPos?.top,
  });

  const cardContentStyle = [
    styles.card,
    cardBase,
    variant === "sheet" ? styles.cardSheet : isDialog ? styles.cardDialog : styles.cardPopover,
    // Sheets: as wide as a form on larger screens (lib/screenLayout) and clear of the home indicator.
    variant === "sheet" ? { maxWidth: screenContentFrame(screenW, "narrow").maxWidth, paddingBottom: insets.bottom } : null,
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

  // Opt-in internal scrolling (see `scrollContent`). `overscrollBehavior: contain` stops the wheel / touch scroll from chaining to the page behind on web.
  const scrolls = scrollContent === true || (scrollContent === "short" && height < SHORT_WINDOW_HEIGHT);
  const body = scrolls ? (
    <ScrollView
      style={styles.scroll}
      bounces={false}
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
    >
      {children}
    </ScrollView>
  ) : (
    children
  );

  // Landscape notches / cutouts: keep dialogs and sheets clear of the side and bottom safe areas (all zero in a desktop browser).
  const backdropInsets =
    isDialog
      ? { paddingTop: theme.spacing.lg + insets.top, paddingBottom: theme.spacing.lg + insets.bottom, paddingLeft: theme.spacing.lg + insets.left, paddingRight: theme.spacing.lg + insets.right }
      : variant === "sheet"
        ? { paddingLeft: insets.left, paddingRight: insets.right }
        : null;

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
          backdropInsets,
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
            {body}
          </Animated.View>
        ) : (
          <View style={cardContentStyle}>{body}</View>
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
    ...StyleSheet.absoluteFill,
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
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
    // react-native-web accepts this style; it keeps the scroll inside the card.
    overscrollBehavior: "contain",
  } as ViewStyle,
  cardPopover: {
    marginTop: theme.spacing.sm,
  },
  cardDialog: {
    width: "100%",
    maxWidth: LAYOUT.modal.dialogMaxWidth,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  cardSheet: {
    width: "100%",
    alignSelf: "center",
    borderBottomWidth: 0,
  },
});

