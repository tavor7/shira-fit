import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

type LangProps = {
  /** Align with header toolbar row (slightly shorter). */
  size?: "default" | "toolbar";
};

/** Compact language switch for the app header (SecureStore-safe on web via I18n). */
export function LanguageHeaderButton({ size = "default" }: LangProps) {
  const { language, toggleLanguage, t } = useI18n();
  const label = language === "he" ? "EN" : "עב";
  const toolbar = size === "toolbar";

  return (
    <Pressable
      onPress={toggleLanguage}
      style={({ pressed }) => [styles.pill, toolbar && styles.pillToolbar, pressed && styles.pillPressed]}
      accessibilityRole="button"
      accessibilityLabel={t("lang.switch")}
    >
      <Text style={[styles.pillTxt, toolbar && styles.pillTxtToolbar]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 40,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  pillToolbar: { height: 30, minWidth: 36, paddingHorizontal: 9 },
  pillPressed: { opacity: 0.88, backgroundColor: theme.colors.surface },
  pillTxt: { color: theme.colors.cta, fontWeight: "900", fontSize: 13, letterSpacing: 0.5 },
  pillTxtToolbar: { fontSize: 12 },
});
