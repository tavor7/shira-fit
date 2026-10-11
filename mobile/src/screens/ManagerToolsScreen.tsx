import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { FadeSlideIn } from "../components/FadeSlideIn";
import { rowFlipFor } from "../lib/layoutDirection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { AppIcon, type AppIconName } from "../components/AppIcon";

type Tool = { titleKey: string; subtitleKey: string; path: string; icon: AppIconName };

const tools: Tool[] = [
  { titleKey: "menu.approve", subtitleKey: "managerTools.approveSub", path: "/(app)/manager/approve", icon: "checkmark-circle-outline" },
  { titleKey: "menu.activityLog", subtitleKey: "managerTools.activityLogSub", path: "/(app)/manager/activity-log", icon: "list-outline" },
  { titleKey: "menu.athleteActivity", subtitleKey: "managerTools.athleteActivitySub", path: "/(app)/manager/participant-history", icon: "search-outline" },
  { titleKey: "menu.coachHistory", subtitleKey: "managerTools.coachHistorySub", path: "/(app)/manager/coach-sessions-report", icon: "bar-chart-outline" },
  { titleKey: "menu.openingSchedule", subtitleKey: "managerTools.openingScheduleSub", path: "/(app)/manager/opening-schedule", icon: "time-outline" },
];

const superUserTool: Tool = {
  titleKey: "menu.superUserHidden",
  subtitleKey: "managerTools.superUserHiddenSub",
  path: "/(app)/super/hidden-workouts",
  icon: "eye-outline",
};

export default function ManagerToolsScreen() {
  const { t, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("standard");
  const { profile } = useAuth();
  const visibleTools = profile?.is_super_user === true ? [...tools, superUserTool] : tools;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, screenContent]}>
      <Text style={[styles.title, isRTL && styles.rtlText]}>{t("managerTools.title")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("managerTools.hint")}</Text>

      <View style={styles.grid}>
        {visibleTools.map((tool, index) => (
          <FadeSlideIn key={tool.path} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
            <Pressable
              onPress={() => router.push(tool.path as never)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
              accessibilityRole="button"
            >
              <View style={[styles.cardRow, rowFlipFor(isRTL) && styles.cardRowRtl]}>
                <View style={styles.cardIcon}>
                  <AppIcon name={tool.icon} size="md" color={theme.colors.textMuted} />
                </View>
                <View style={styles.cardText}>
                  <Text style={[styles.cardTitle, isRTL && styles.rtlText]}>{t(tool.titleKey)}</Text>
                  <Text style={[styles.cardSub, isRTL && styles.rtlText]}>{t(tool.subtitleKey)}</Text>
                </View>
              </View>
            </Pressable>
          </FadeSlideIn>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  title: { fontSize: 20, fontWeight: "800", color: theme.colors.text },
  hint: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18 },
  rtlText: { textAlign: "right" },
  grid: { marginTop: theme.spacing.md, gap: theme.spacing.md },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cardRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  cardRowRtl: { flexDirection: "row-reverse" },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
  },
  cardText: { flex: 1 },
  cardTitle: { color: theme.colors.text, fontWeight: "800", fontSize: 16 },
  cardSub: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18 },
});
