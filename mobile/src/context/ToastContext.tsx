import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

type ToastPayload = {
  message: string;
  /** Second line, muted (e.g. explanation after a short title). */
  detail?: string;
  variant?: "success" | "info" | "error";
};

type Ctx = { showToast: (p: ToastPayload) => void };

const ToastCtx = createContext<Ctx | null>(null);

const TOAST_MS = 2800;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotionRef = useRef(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      reduceMotionRef.current = v;
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => {
      reduceMotionRef.current = v;
    });
    return () => sub.remove();
  }, []);

  const showToast = useCallback(
    (p: ToastPayload) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setToast(p);
      if (Platform.OS === "ios" || Platform.OS === "android") {
        const a11y = p.detail ? `${p.message}. ${p.detail}` : p.message;
        AccessibilityInfo.announceForAccessibility(a11y);
      }
      const reduceMotion = reduceMotionRef.current;
      Animated.timing(progress, {
        toValue: 1,
        duration: reduceMotion ? 0 : theme.motion.normal,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(progress, {
          toValue: 0,
          duration: reduceMotion ? 0 : theme.motion.fast,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(() => setToast(null));
      }, TOAST_MS);
    },
    [progress]
  );

  return (
    <ToastCtx.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <View style={styles.layer} pointerEvents="none" accessibilityLiveRegion="polite">
          <Animated.View
            style={[
              styles.toastWrap,
              {
                opacity: progress,
                transform: [
                  { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                ],
              },
            ]}
          >
            <View
              style={[
                styles.toast,
                toast.variant === "success"
                  ? styles.toastSuccess
                  : toast.variant === "error"
                    ? styles.toastError
                    : styles.toastInfo,
              ]}
              accessibilityRole="text"
            >
              <Text style={styles.toastTxt}>{toast.message}</Text>
              {toast.detail ? <Text style={styles.toastDetail}>{toast.detail}</Text> : null}
            </View>
          </Animated.View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const v = useContext(ToastCtx);
  if (!v) throw new Error("useToast must be used within ToastProvider");
  return v;
}

const styles = StyleSheet.create({
  /** Sit above RN Modal / sheets so feedback is visible while dialogs are open. */
  layer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    paddingBottom: 56,
    paddingHorizontal: theme.spacing.md,
    zIndex: 999_999,
    elevation: 80,
    ...(Platform.OS === "web" ? { position: "fixed" as const } : {}),
  },
  toastWrap: { alignItems: "center" },
  toast: {
    maxWidth: 420,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
  },
  toastSuccess: {
    backgroundColor: theme.colors.successBg,
    borderColor: theme.colors.success,
  },
  toastInfo: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderMuted,
  },
  toastError: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  toastTxt: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 20,
  },
  toastDetail: {
    marginTop: 4,
    color: theme.colors.textMuted,
    fontWeight: "500",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
});
