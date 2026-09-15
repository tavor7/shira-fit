import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAccessibilityPrefs, type AccessibilityPrefs } from "../context/AccessibilityContext";
import { useAuth } from "../context/AuthContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { AppText } from "./AppText";

/**
 * Web/PWA-only floating accessibility control. Supplements — does not replace — the
 * underlying accessibility work (labels, roles, focus order, contrast) done elsewhere;
 * see the Accessibility Statement for what's covered by this menu vs. by the app itself.
 */
export function AccessibilityMenu() {
  if (Platform.OS !== "web") return null;
  return <AccessibilityMenuInner />;
}

function AccessibilityMenuInner() {
  const { isRTL, t } = useI18n();
  const { prefs, setPrefs, reset } = useAccessibilityPrefs();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View>(null);
  const reduceMotionRef = useReduceMotionRef();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  // StudioContactFooter (Instagram / Website / Call) is shown to everyone except staff —
  // clear it instead of floating on top of it. It carries its own insets.bottom padding
  // internally, so this only needs the row's own content height plus a small gap.
  const isStaff = profile?.role === "coach" || profile?.role === "manager";
  const fabBottom = insets.bottom + (isStaff ? 20 : 78);
  const scale = useRef(new Animated.Value(1)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const step = (delta: 1 | -1) => {
    const steps: AccessibilityPrefs["textScale"][] = [1, 1.15, 1.3];
    const idx = steps.indexOf(prefs.textScale);
    const next = steps[Math.min(steps.length - 1, Math.max(0, idx + delta))] ?? 1;
    setPrefs({ textScale: next });
  };

  function animatePress() {
    if (reduceMotionRef.current) {
      setOpen(true);
      return;
    }
    rotate.setValue(0);
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.82, duration: 90, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }),
        // Rotate out and back to neutral (a little "flourish"), rather than settling
        // rotated — the icon must end this animation exactly where it started.
        Animated.sequence([
          Animated.timing(rotate, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(rotate, { toValue: 0, duration: 220, easing: theme.motion.springOvershoot, useNativeDriver: true }),
        ]),
      ]),
    ]).start();
    setOpen(true);
  }

  const rotateDeg = rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "18deg"] });

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={animatePress}
        style={({ pressed }) => [
          styles.fab,
          { bottom: fabBottom },
          isRTL ? styles.fabStart : styles.fabEnd,
          pressed && styles.fabPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("a11yMenu.open")}
      >
        <Animated.View style={{ transform: [{ scale }, { rotate: rotateDeg }] }}>
          <Ionicons name="accessibility" size={22} color={theme.colors.ctaText} />
        </Animated.View>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel={t("a11yMenu.close")}>
          <Pressable style={styles.panelWrap} onPress={(e) => e.stopPropagation()}>
            <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
              <AppText variant="title" isRTL={isRTL} style={styles.panelTitle} accessibilityRole="header">
                {t("a11yMenu.title")}
              </AppText>

              <View style={styles.row}>
                <AppText variant="body" isRTL={isRTL} style={styles.rowLabel}>
                  {t("a11yMenu.textSize")}
                </AppText>
                <View style={styles.stepper}>
                  <Pressable
                    onPress={() => step(-1)}
                    style={styles.stepBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t("a11yMenu.decrease")}
                  >
                    <AppText variant="body" style={styles.stepBtnTxt}>
                      A-
                    </AppText>
                  </Pressable>
                  <Pressable
                    onPress={() => step(1)}
                    style={styles.stepBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t("a11yMenu.increase")}
                  >
                    <AppText variant="body" style={styles.stepBtnTxt}>
                      A+
                    </AppText>
                  </Pressable>
                </View>
              </View>

              <ToggleRow
                label={t("a11yMenu.highContrast")}
                value={prefs.highContrast}
                onChange={(v) => setPrefs({ highContrast: v })}
                isRTL={isRTL}
              />
              <ToggleRow
                label={t("a11yMenu.focusVisibility")}
                value={prefs.enhancedFocus}
                onChange={(v) => setPrefs({ enhancedFocus: v })}
                isRTL={isRTL}
              />
              <ToggleRow
                label={t("a11yMenu.reduceMotion")}
                value={prefs.reduceMotion}
                onChange={(v) => setPrefs({ reduceMotion: v })}
                isRTL={isRTL}
              />
              <ToggleRow
                label={t("a11yMenu.underlineLinks")}
                value={prefs.underlineLinks}
                onChange={(v) => setPrefs({ underlineLinks: v })}
                isRTL={isRTL}
              />

              <Pressable
                onPress={reset}
                style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
              >
                <AppText variant="caption" style={styles.resetTxt}>
                  {t("a11yMenu.reset")}
                </AppText>
              </Pressable>
              <Pressable
                onPress={() => setOpen(false)}
                style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
              >
                <AppText variant="body" style={styles.closeTxt}>
                  {t("a11yMenu.close")}
                </AppText>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  isRTL,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  isRTL: boolean;
}) {
  return (
    <Pressable
      style={[styles.row, isRTL && styles.rowRtl]}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <AppText variant="body" isRTL={isRTL} style={styles.rowLabel}>
        {label}
      </AppText>
      <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
        <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "fixed" as "absolute",
    zIndex: 9500,
    width: 46,
    height: 46,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
    borderWidth: 1,
    borderColor: "rgba(10,10,11,0.06)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  fabEnd: { right: 20 },
  fabStart: { left: 20 },
  fabPressed: { opacity: 0.88 },
  backdrop: {
    flex: 1,
    backgroundColor: theme.overlay.backdrop,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  panelWrap: { width: "100%", maxWidth: 380, maxHeight: "80%" },
  panel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  panelContent: { padding: theme.spacing.lg },
  panelTitle: { marginBottom: theme.spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowLabel: { flex: 1 },
  stepper: { flexDirection: "row", gap: theme.spacing.xs },
  stepBtn: {
    width: 40,
    height: 36,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
  },
  stepBtnTxt: { fontWeight: "800" },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.accent,
    padding: 3,
    justifyContent: "center",
  },
  switchTrackOn: { backgroundColor: theme.colors.success },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.white,
  },
  switchThumbOn: { alignSelf: "flex-end" },
  resetBtn: { alignSelf: "center", marginTop: theme.spacing.md, padding: theme.spacing.xs },
  resetTxt: { color: theme.colors.textMuted, fontWeight: "700" },
  closeBtn: {
    marginTop: theme.spacing.sm,
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  closeTxt: { color: theme.colors.ctaText, fontWeight: "800" },
});
