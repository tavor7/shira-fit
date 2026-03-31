import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../context/I18nContext";
import { theme } from "../theme";

/**
 * Small chip to toggle language (EN <-> HE).
 * Used on auth (pre-login) screens where the global menu is unavailable.
 */
export function LanguageToggleChip() {
  const { language, toggleLanguage } = useI18n();
  const next = language === "he" ? "EN" : "עב";
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => void toggleLanguage()}
        style={({ pressed }) => [styles.chip, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityLabel={language === "he" ? "Switch to English" : "Switch to Hebrew"}
      >
        <Text style={styles.txt}>{next}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: theme.spacing.md, right: theme.spacing.md, zIndex: 10 },
  chip: {
    height: 36,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  txt: { color: theme.colors.text, fontWeight: "900", letterSpacing: 0.6 },
});

