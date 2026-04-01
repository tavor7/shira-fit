import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

type ToastPayload = { message: string; variant?: "success" | "info" };

type Ctx = { showToast: (p: ToastPayload) => void };

const ToastCtx = createContext<Ctx | null>(null);

const TOAST_MS = 2800;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((p: ToastPayload) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToast(p);
    if (Platform.OS === "ios" || Platform.OS === "android") {
      AccessibilityInfo.announceForAccessibility(p.message);
    }
    hideTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  return (
    <ToastCtx.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <View style={styles.layer} pointerEvents="none" accessibilityLiveRegion="polite">
          <View style={styles.toastWrap}>
            <View
              style={[styles.toast, toast.variant === "success" ? styles.toastSuccess : styles.toastInfo]}
              accessibilityRole="text"
            >
              <Text style={styles.toastTxt}>{toast.message}</Text>
            </View>
          </View>
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
  layer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    paddingBottom: 56,
    paddingHorizontal: theme.spacing.md,
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
  toastTxt: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 20,
  },
});
