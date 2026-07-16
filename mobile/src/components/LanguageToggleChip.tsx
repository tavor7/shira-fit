import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../context/I18nContext";
import { theme } from "../theme";

/**
 * Segmented EN / עב switcher for auth (pre-login) screens where the global menu is unavailable.
 */
export function LanguageToggleChip() {
  const { language, setLanguage } = useI18n();
  const isHe = language === "he";
  return (
    <View style={styles.wrap}>
      <View style={styles.track}>
        <Pressable
          onPress={() => void setLanguage("en")}
          style={({ pressed }) => [styles.segment, !isHe && styles.segmentOn, pressed && styles.segmentPressed]}
          accessibilityRole="button"
          accessibilityState={{ selected: !isHe }}
          accessibilityLabel="English"
          hitSlop={4}
        >
          <Text style={[styles.txt, !isHe && styles.txtOn]}>EN</Text>
        </Pressable>
        <Pressable
          onPress={() => void setLanguage("he")}
          style={({ pressed }) => [styles.segment, isHe && styles.segmentOn, pressed && styles.segmentPressed]}
          accessibilityRole="button"
          accessibilityState={{ selected: isHe }}
          accessibilityLabel="עברית"
          hitSlop={4}
        >
          <Text style={[styles.txt, isHe && styles.txtOn]}>עב</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: theme.spacing.lg },
  track: {
    flexDirection: "row",
    padding: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  segment: {
    minWidth: 40,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentOn: { backgroundColor: theme.colors.cta },
  segmentPressed: { opacity: 0.85 },
  txt: { color: theme.colors.textSoft, fontWeight: "800", fontSize: 12, letterSpacing: 0.4 },
  txtOn: { color: theme.colors.ctaText },
});
