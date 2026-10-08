import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppIcon } from "./AppIcon";
import { AppText } from "./AppText";

/**
 * Tells people right away when the device reports it is offline (web: navigator.onLine and the
 * online/offline events). Requests still retry as before (postgrest-js retries idempotent reads for
 * ~7s each); this only explains the wait instead of leaving a skeleton on screen. Native has no
 * connectivity signal installed, so it renders nothing there.
 */
export function OfflineNotice() {
  const { t, isRTL } = useI18n();
  const [offline, setOffline] = useState(() => Platform.OS === "web" && typeof navigator !== "undefined" && navigator.onLine === false);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <View pointerEvents="none" style={styles.wrap} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={[styles.pill, isRTL && styles.pillRtl]}>
        <AppIcon name="cloud-offline-outline" size="sm" color={theme.colors.warning} />
        <AppText variant="caption" style={styles.text}>
          {t("network.offlineNotice")}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 72, left: 0, right: 0, alignItems: "center", zIndex: 50 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    paddingVertical: 8,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
    maxWidth: "92%",
  },
  pillRtl: { flexDirection: "row-reverse" },
  text: { color: theme.colors.text },
});
