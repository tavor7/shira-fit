import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import ParticipantHistoryScreen from "./ParticipantHistoryScreen";
import ManagerCoachSessionsReportScreen from "./ManagerCoachSessionsReportScreen";

type Tab = "athlete" | "coach";

export default function ManagerReportsScreen() {
  const { language, t, isRTL } = useI18n();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const initial = (tab === "coach" ? "coach" : "athlete") as Tab;
  const [active, setActive] = useState<Tab>(initial);

  const tabs = useMemo(
    () =>
      [
        { id: "athlete" as const, label: t("menu.athleteActivity") },
        { id: "coach" as const, label: t("menu.coachHistory") },
      ] satisfies { id: Tab; label: string }[],
    [t]
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <ManagerOverviewHubTabs />
        <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.reports")}</Text>
        <Text style={[styles.subtitle, isRTL && styles.rtl]}>
          {active === "athlete" ? t("reports.athleteTabHint") : t("reports.coachTabHint")}
        </Text>

        <View style={[styles.track, isRTL && styles.trackRtl]}>
          {tabs.map((x) => {
            const on = x.id === active;
            return (
              <Pressable
                key={x.id}
                onPress={() => setActive(x.id)}
                style={({ pressed }) => [
                  styles.slot,
                  on && styles.slotOn,
                  pressed && !on && styles.slotPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={language === "he" ? `מעבר ל-${x.label}` : `Go to ${x.label}`}
              >
                <Text style={[styles.slotTxt, on && styles.slotTxtOn]} numberOfLines={1}>
                  {x.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.body}>
        {active === "athlete" ? <ParticipantHistoryScreen hideTitle /> : <ManagerCoachSessionsReportScreen hideTitle />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  header: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  subtitle: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 17, marginTop: -theme.spacing.xs },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.2,
    lineHeight: 26,
  },

  track: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  trackRtl: { flexDirection: "row-reverse" },
  slot: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 120,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  slotOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  slotPressed: { opacity: 0.92 },
  slotTxt: {
    fontWeight: "800",
    fontSize: 12,
    color: theme.colors.textMuted,
    letterSpacing: 0.15,
    lineHeight: 16,
  },
  slotTxtOn: { color: theme.colors.ctaText },

  body: { flex: 1 },
});

