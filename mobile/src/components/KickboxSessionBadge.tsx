import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { KICKBOX_SESSION_ACCENT, KICKBOX_SESSION_BG, KICKBOX_SESSION_BORDER } from "../lib/kickboxSessionStyle";

type Props = {
  compact?: boolean;
  isRTL?: boolean;
};

export function KickboxSessionBadge({ compact, isRTL }: Props) {
  const { t } = useI18n();
  return (
    <View
      style={[styles.badge, compact && styles.badgeCompact, isRTL && styles.badgeRtl]}
      accessibilityRole="text"
      accessibilityLabel={t("session.kickboxSession")}
    >
      <Text style={[styles.txt, compact && styles.txtCompact]}>{t("session.kickboxBadge")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: KICKBOX_SESSION_BG,
    borderWidth: 1,
    borderColor: KICKBOX_SESSION_BORDER,
  },
  badgeCompact: {
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeRtl: { alignSelf: "flex-end" },
  txt: {
    color: KICKBOX_SESSION_ACCENT,
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },
  txtCompact: { fontSize: 9, letterSpacing: 0.4 },
});
