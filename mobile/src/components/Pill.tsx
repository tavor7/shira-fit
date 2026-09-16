import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";

export type PillTone = "neutral" | "success" | "warning" | "danger";

const TONES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: theme.colors.surfaceElevated, fg: theme.colors.textMuted },
  success: { bg: theme.colors.successBg, fg: theme.colors.success },
  warning: { bg: theme.colors.warningBg, fg: theme.colors.warning },
  danger: { bg: theme.colors.errorBg, fg: theme.colors.error },
};

/** Small rounded status/role badge — shared look for compact metadata across list rows. */
export function Pill({ label, tone = "neutral" }: { label: string; tone?: PillTone }) {
  const c = TONES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.txt, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: theme.radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  txt: { fontSize: 11, fontWeight: "800" },
});
