import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useActiveUserCount } from "../context/AppPresenceContext";

/** A single small line — "N active now" — nothing heavier. Renders nothing until the count is known. */
export function ActiveUsersIndicator() {
  const { t, isRTL } = useI18n();
  const count = useActiveUserCount();
  if (count == null) return null;

  return (
    <View style={[styles.row, isRTL && styles.rowRtl]}>
      <View style={styles.dot} />
      <Text style={styles.txt}>{t("activeUsers.now").replace("{n}", String(count))}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowRtl: { flexDirection: "row-reverse" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.success },
  txt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
});
