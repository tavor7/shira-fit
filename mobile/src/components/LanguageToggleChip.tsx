import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../context/I18nContext";
import { theme } from "../theme";

/**
 * Ghost outline chip to toggle language (EN <-> HE).
 * Used on auth (pre-login) screens where the global menu is unavailable.
 */
export function LanguageToggleChip() {
  const { language, toggleLanguage } = useI18n();
  const isHe = language === "he";
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => void toggleLanguage()}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        accessibilityRole="button"
        accessibilityLabel={isHe ? "Switch to English" : "Switch to Hebrew"}
        hitSlop={6}
      >
        <Text style={styles.icon}>{"🌐"}</Text>
        <Text style={styles.txt}>{isHe ? "עב" : "EN"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: theme.spacing.lg },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: "transparent",
  },
  chipPressed: { opacity: 0.7, backgroundColor: theme.colors.surfaceElevated },
  icon: { fontSize: 13 },
  txt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 12, letterSpacing: 0.6 },
});
