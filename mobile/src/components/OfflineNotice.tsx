import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useIsOffline, useLoadingPlaceholdersActive } from "../lib/networkStatus";
import { nextOfflineNoticePhase, type OfflineNoticePhase } from "../lib/offlineNoticePhase";
import { AppIcon } from "./AppIcon";
import { AppText } from "./AppText";
import { rowFlipFor } from "../lib/layoutDirection";

const BACK_ONLINE_MS = 2500;
const RECONNECTING_MAX_MS = 15000;

/** Phase of the connection bar; the root layout reads it once and hands the top safe area to the bar while it shows. */
export function useOfflineNoticePhase(): OfflineNoticePhase {
  const offline = useIsOffline();
  const loading = useLoadingPlaceholdersActive();
  const [phase, setPhase] = useState<OfflineNoticePhase>(offline ? "offline" : null);
  // Adjust the phase while rendering when connectivity / loading change (no effect round-trip).
  const [seen, setSeen] = useState({ offline, loading });
  if (seen.offline !== offline || seen.loading !== loading) {
    setSeen({ offline, loading });
    setPhase(nextOfflineNoticePhase(phase, { offline, loading }));
  }

  useEffect(() => {
    if (phase !== "backOnline" && phase !== "reconnecting") return;
    const id = setTimeout(
      () => setPhase((p) => (p === phase ? null : p)),
      phase === "backOnline" ? BACK_ONLINE_MS : RECONNECTING_MAX_MS
    );
    return () => clearTimeout(id);
  }, [phase]);

  return phase;
}

/**
 * Connection bar (Phase 5 / O + T). Part of the layout above the app (it pushes content down instead of
 * covering the tabs). While offline it says so at once — and, when the page is still waiting on data,
 * that this page can't load yet. After reconnecting: "Reconnecting…" while placeholders remain, then
 * "Back online". Requests still retry exactly as before; the error states with Try again are unchanged.
 * Native has no connectivity signal installed, so it renders nothing there.
 */
export function OfflineNotice({ phase, topInset = 0 }: { phase: OfflineNoticePhase; topInset?: number }) {
  const { t, isRTL } = useI18n();
  const loading = useLoadingPlaceholdersActive();
  if (!phase) return null;

  const tone = phase === "backOnline" ? "ok" : phase === "reconnecting" ? "info" : "warn";
  const message =
    phase === "offline"
      ? t(loading ? "network.offlineLoading" : "network.offlineNotice")
      : phase === "reconnecting"
        ? t("network.reconnecting")
        : t("network.backOnline");
  const icon = phase === "backOnline" ? "cloud-done-outline" : phase === "reconnecting" ? "sync-outline" : "cloud-offline-outline";
  const color = tone === "ok" ? theme.colors.success : tone === "info" ? theme.colors.info : theme.colors.warning;

  return (
    <View
      style={[styles.bar, tone === "ok" ? styles.barOk : tone === "info" ? styles.barInfo : styles.barWarn, { paddingTop: 8 + topInset }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl]}>
        <AppIcon name={icon} size="sm" color={color} />
        <AppText variant="caption" style={[styles.text, isRTL && styles.textRtl]}>
          {message}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingBottom: 8,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: 1,
  },
  barWarn: { backgroundColor: "#2a2210", borderBottomColor: theme.colors.warningBorder },
  barInfo: { backgroundColor: "#132131", borderBottomColor: theme.colors.infoBorder },
  barOk: { backgroundColor: theme.colors.successBg, borderBottomColor: "rgba(34,197,94,0.4)" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  rowRtl: { flexDirection: "row-reverse" },
  text: { color: theme.colors.text, flexShrink: 1, textAlign: "center" },
  textRtl: { writingDirection: "rtl" },
});

/**
 * Root wrapper: the connection bar sits above the app and takes the top safe-area inset while it shows,
 * so the screen headers below it don't add the inset a second time. The tree shape never changes,
 * so connectivity flapping can't remount the navigator.
 */
export function ConnectionBarLayout({ children }: { children: ReactNode }) {
  const phase = useOfflineNoticePhase();
  const insets = useSafeAreaInsets();
  const inner = useMemo(() => (phase ? { ...insets, top: 0 } : insets), [phase, insets]);
  return (
    <>
      <OfflineNotice phase={phase} topInset={insets.top} />
      <SafeAreaInsetsContext.Provider value={inner}>{children}</SafeAreaInsetsContext.Provider>
    </>
  );
}
