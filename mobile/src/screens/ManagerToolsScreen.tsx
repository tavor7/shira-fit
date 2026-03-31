import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

type Tool = { title: string; subtitle: string; path: string };

const tools: Tool[] = [
  { title: "Approve athletes", subtitle: "Approve or reject new athletes", path: "/(app)/manager/approve" },
  { title: "Roles", subtitle: "Promote/demote users (athlete/coach/manager)", path: "/(app)/manager/roles" },
  { title: "Trainer colors", subtitle: "Set calendar colors for coaches/managers", path: "/(app)/manager/trainer-colors" },
  { title: "Participant history", subtitle: "Search athlete and view registrations", path: "/(app)/manager/participant-history" },
  { title: "Trainer report", subtitle: "Sessions + registered/arrived counts", path: "/(app)/manager/coach-sessions-report" },
  { title: "Registration opening", subtitle: "Configure the weekly opening day/time", path: "/(app)/manager/opening-schedule" },
];

export default function ManagerToolsScreen() {
  const { language, isRTL } = useI18n();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[styles.title, isRTL && styles.rtlText]}>{language === "he" ? "כלי מנהל" : "Manager tools"}</Text>
      <Text style={[styles.hint, isRTL && styles.rtlText]}>
        {language === "he" ? "כל הפעולות למנהלים במקום אחד." : "All manager-only actions in one place."}
      </Text>

      <View style={styles.grid}>
        {tools.map((t) => (
          <Pressable
            key={t.path}
            onPress={() => router.push(t.path as never)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
            accessibilityRole="button"
          >
            <Text style={[styles.cardTitle, isRTL && styles.rtlText]}>
              {language === "he"
                ? t.title === "Approve athletes"
                  ? "אישור מתאמנים"
                  : t.title === "Roles"
                    ? "תפקידים"
                    : t.title === "Trainer colors"
                      ? "צבעי מאמנים"
                      : t.title === "Participant history"
                        ? "היסטוריית מתאמנים"
                        : t.title === "Trainer report"
                          ? "דוח מאמן"
                          : t.title === "Registration opening"
                            ? "פתיחת הרשמה"
                            : t.title
                : t.title}
            </Text>
            <Text style={[styles.cardSub, isRTL && styles.rtlText]}>
              {language === "he"
                ? t.subtitle === "Approve or reject new athletes"
                  ? "אישור או דחייה של מתאמנים חדשים"
                  : t.subtitle === "Promote/demote users (athlete/coach/manager)"
                    ? "שינוי תפקידים (מתאמן/מאמן/מנהל)"
                    : t.subtitle === "Set calendar colors for coaches/managers"
                      ? "קביעת צבעים ביומן למאמנים/מנהלים"
                      : t.subtitle === "Search athlete and view registrations"
                        ? "חיפוש מתאמן וצפייה בהרשמות"
                        : t.subtitle === "Sessions + registered/arrived counts"
                          ? "אימונים + מספר נרשמו/הגיעו"
                          : t.subtitle === "Configure the weekly opening day/time"
                            ? "קביעת יום/שעה לפתיחת הרשמה שבועית"
                            : t.subtitle
                : t.subtitle}
            </Text>
          </Pressable>
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
  cardTitle: { color: theme.colors.text, fontWeight: "900", fontSize: 16 },
  cardSub: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18 },
});

