import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewHubTabs } from "../components/ManagerOverviewTabs";
import { SlidingPillTabBar } from "../components/SlidingPillTabBar";
import { FadeSlideIn } from "../components/FadeSlideIn";
import ParticipantHistoryScreen from "./ParticipantHistoryScreen";
import ManagerCoachSessionsReportScreen from "./ManagerCoachSessionsReportScreen";

type Tab = "athlete" | "coach";

export default function ManagerReportsScreen() {
  const { t, isRTL } = useI18n();
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

        <SlidingPillTabBar tabs={tabs} active={active} onChange={(id) => setActive(id as Tab)} />
      </View>

      <FadeSlideIn key={active} style={styles.body}>
        {active === "athlete" ? <ParticipantHistoryScreen hideTitle /> : <ManagerCoachSessionsReportScreen hideTitle />}
      </FadeSlideIn>
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

  body: { flex: 1 },
});

