import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppIcon } from "../components/AppIcon";
import { useStudioSetupItems } from "../components/ManagerOverviewTabs";
import { rowFlipFor } from "../lib/layoutDirection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

/** Studio setup on phones (Phase 5 / H): every setting with a one-line description; each opens its page (Back returns here). */
export default function StudioSetupIndexScreen() {
  const { t, isRTL } = useI18n();
  const items = useStudioSetupItems();
  const screenContent = useScreenContentStyle("standard");
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, screenContent]}>
      <View style={styles.list}>
        {items.map((it, i) => (
          <Pressable
            key={it.id}
            onPress={() => router.push(it.href as never)}
            accessibilityRole="link"
            accessibilityLabel={`${it.label}. ${it.description}`}
            style={({ pressed }) => [
              styles.row,
              rowFlipFor(isRTL) && styles.rowRtl,
              i === items.length - 1 && styles.rowLast,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={styles.icon}>
              <AppIcon name={it.icon} size="md" color={theme.colors.text} />
            </View>
            <View style={styles.text}>
              <Text style={[styles.label, isRTL && styles.rtl]} numberOfLines={1}>
                {it.label}
              </Text>
              <Text style={[styles.desc, isRTL && styles.rtl]} numberOfLines={2}>
                {it.description}
              </Text>
            </View>
            <AppIcon name={isRTL ? "chevron-back" : "chevron-forward"} size="sm" color={theme.colors.textSoft} />
          </Pressable>
        ))}
      </View>
      <Text style={[styles.note, isRTL && styles.rtl]}>{t("setup.indexNote")}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, gap: theme.spacing.md },
  list: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 64,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowLast: { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: theme.colors.surfaceElevated },
  icon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  label: { ...theme.typography.title, color: theme.colors.text },
  desc: { ...theme.typography.helper, color: theme.colors.textMuted },
  note: { ...theme.typography.helper, color: theme.colors.textSoft },
  rtl: { textAlign: "right", alignSelf: "stretch" },
});
