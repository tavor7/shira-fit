import { Pressable, StyleSheet, Text } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import { useI18n } from "../context/I18nContext";

type ToggleProps = {
  size?: "default" | "toolbar";
};

/** Manager-only: switch between staff navigation and participant-style navigation. */
export function ManagerAthleteViewToggle({ size = "default" }: ToggleProps) {
  const { profile } = useAuth();
  const { enabled, setEnabled } = useManagerAthletePreview();
  const { language, t } = useI18n();

  if (profile?.role !== "manager") return null;

  async function toggle() {
    const next = !enabled;
    await setEnabled(next);
    if (next) router.replace("/(app)/athlete/sessions");
    else router.replace("/(app)/manager/sessions");
  }

  const toolbar = size === "toolbar";
  const label =
    toolbar
      ? language === "he"
        ? "תצוגה"
        : "Preview"
      : language === "he"
        ? "תצוגת מתאמן"
        : "Athlete view";
  const a11yLabel =
    language === "he"
      ? `${enabled ? "תצוגת מתאמן פעילה" : "תצוגת מתאמן כבויה"}. ${enabled ? t("common.on") : t("common.off")}`
      : `Athlete view. ${enabled ? t("common.on") : t("common.off")}`;

  return (
    <Pressable
      onPress={() => void toggle()}
      style={({ pressed }) => [
        styles.pill,
        toolbar && styles.pillToolbar,
        enabled ? styles.pillOn : styles.pillOff,
        pressed && styles.pillPressed,
      ]}
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      accessibilityLabel={a11yLabel}
    >
      <Text style={[styles.pillTxt, toolbar && styles.pillTxtToolbar, enabled && styles.pillTxtOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    maxWidth: 108,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  pillToolbar: { maxWidth: 72, height: 30, paddingHorizontal: 7 },
  pillOff: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.borderMuted,
  },
  pillOn: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  pillPressed: { opacity: 0.88 },
  pillTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 11, letterSpacing: 0.2 },
  pillTxtToolbar: { fontSize: 10 },
  pillTxtOn: { color: theme.colors.ctaText },
});
