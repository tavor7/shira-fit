import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

/**
 * One header for every report screen (Phase 5 / J): page title, one-line description, then the
 * screen's period controls and filters below it — never the title inside the period card.
 */
export function ReportPageHeader({ title, description }: { title: string; description?: string }) {
  const { isRTL } = useI18n();
  return (
    <View style={styles.wrap}>
      <Text accessibilityRole="header" style={[styles.title, isRTL && styles.rtl]}>
        {title}
      </Text>
      {description ? <Text style={[styles.desc, isRTL && styles.rtl]}>{description}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4, marginBottom: theme.spacing.sm },
  title: { ...theme.typography.display, color: theme.colors.text },
  desc: { ...theme.typography.secondary, color: theme.colors.textMuted },
  rtl: { textAlign: "right", alignSelf: "stretch" },
});
