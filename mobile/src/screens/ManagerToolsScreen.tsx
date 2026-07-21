import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { FadeSlideIn } from "../components/FadeSlideIn";

type Tool = { titleKey: string; subtitleKey: string; path: string; icon: string };

const tools: Tool[] = [
  { titleKey: "menu.approve", subtitleKey: "managerTools.approveSub", path: "/(app)/manager/approve", icon: "✅" },
  { titleKey: "menu.activityLog", subtitleKey: "managerTools.activityLogSub", path: "/(app)/manager/activity-log", icon: "📋" },
  { titleKey: "menu.roles", subtitleKey: "managerTools.rolesSub", path: "/(app)/manager/roles", icon: "🎚️" },
  { titleKey: "menu.trainerColors", subtitleKey: "managerTools.trainerColorsSub", path: "/(app)/manager/trainer-colors", icon: "🎨" },
  { titleKey: "menu.athleteActivity", subtitleKey: "managerTools.athleteActivitySub", path: "/(app)/manager/participant-history", icon: "🔍" },
  { titleKey: "menu.coachHistory", subtitleKey: "managerTools.coachHistorySub", path: "/(app)/manager/coach-sessions-report", icon: "📊" },
  { titleKey: "menu.openingSchedule", subtitleKey: "managerTools.openingScheduleSub", path: "/(app)/manager/opening-schedule", icon: "🕒" },
];

export default function ManagerToolsScreen() {
  const { t, isRTL } = useI18n();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[styles.title, isRTL && styles.rtlText]}>{t("managerTools.title")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("managerTools.hint")}</Text>

      <View style={styles.grid}>
        {tools.map((tool, index) => (
          <FadeSlideIn key={tool.path} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
            <Pressable
              onPress={() => router.push(tool.path as never)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
              accessibilityRole="button"
            >
              <View style={[styles.cardRow, isRTL && styles.cardRowRtl]}>
                <Text style={styles.cardIcon} accessibilityElementsHidden>
                  {tool.icon}
                </Text>
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
  title: { fontSize: 20, fontWeight: "900", color: theme.colors.text },
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
  cardIcon: { fontSize: 22, width: 30, textAlign: "center" },
  cardText: { flex: 1 },
  cardTitle: { color: theme.colors.text, fontWeight: "900", fontSize: 16 },
  cardSub: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18 },
});
