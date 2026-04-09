import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ManagerOverviewTabs />
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.reports")}</Text>

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
                pressed && !on && { opacity: 0.9 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={language === "he" ? `מעבר ל-${x.label}` : `Go to ${x.label}`}
            >
              <Text style={[styles.slotTxt, on && styles.slotTxtOn]} numberOfLines={1}>
                {x.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.body}>
        {active === "athlete" ? <ParticipantHistoryScreen hideTitle /> : <ManagerCoachSessionsReportScreen hideTitle />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: 40 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: 10 },

  track: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.md,
  },
  trackRtl: { flexDirection: "row-reverse" },
  slot: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 120,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  slotOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  slotTxt: { fontWeight: "900", fontSize: 12, color: theme.colors.textMuted, letterSpacing: 0.2 },
  slotTxtOn: { color: theme.colors.ctaText },

  body: { marginTop: 6 },
});

