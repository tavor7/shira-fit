import { View, Text, TextInput, StyleSheet } from "react-native";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { useI18n } from "../context/I18nContext";
import { AppSwitch } from "./AppSwitch";

type Props = {
  repeatOngoing: boolean;
  onRepeatOngoingChange: (v: boolean) => void;
  weeklyOccurrences: string;
  onWeeklyOccurrencesChange: (v: string) => void;
  repeatCopyRoster: boolean;
  onRepeatCopyRosterChange: (v: boolean) => void;
};

export function SessionSeriesOptionsExpand({
  repeatOngoing,
  onRepeatOngoingChange,
  weeklyOccurrences,
  onWeeklyOccurrencesChange,
  repeatCopyRoster,
  onRepeatCopyRosterChange,
}: Props) {
  const { t, isRTL } = useI18n();

  return (
    <View style={styles.panel}>
      <View style={[styles.optionCard, isRTL && styles.optionCardRtl]}>
        <View style={styles.optionMain}>
          <Text style={[styles.optionTitle, isRTL && styles.rtl]}>{t("session.seriesOngoing")}</Text>
          <Text style={[styles.optionHint, isRTL && styles.rtl]}>{t("session.seriesOngoingHint")}</Text>
        </View>
        <AppSwitch
          value={repeatOngoing}
          onValueChange={onRepeatOngoingChange}
          accessibilityLabel={t("session.seriesOngoing")}
        />
      </View>

      {!repeatOngoing ? (
        <View style={styles.weeksBlock}>
          <Text style={[sf.label, isRTL && sf.labelRtl]}>{t("session.weeklyOccurrences")}</Text>
          <TextInput
            style={[sf.control, sf.controlInput, styles.weeksInput]}
            value={weeklyOccurrences}
            onChangeText={onWeeklyOccurrencesChange}
            keyboardType="number-pad"
            placeholder="4"
            placeholderTextColor={theme.colors.textSoft}
            accessibilityLabel={t("session.weeklyOccurrences")}
          />
        </View>
      ) : null}

      <View style={styles.divider} />

      <View style={[styles.optionCard, isRTL && styles.optionCardRtl]}>
        <View style={styles.optionMain}>
          <Text style={[styles.optionTitle, isRTL && styles.rtl]}>{t("session.seriesCopyRoster")}</Text>
          <Text style={[styles.optionHint, isRTL && styles.rtl]}>{t("session.seriesCopyRosterHint")}</Text>
        </View>
        <AppSwitch
          value={repeatCopyRoster}
          onValueChange={onRepeatCopyRosterChange}
          onColor={theme.colors.success}
          accessibilityLabel={t("session.seriesCopyRoster")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    padding: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    gap: 12,
  },
  optionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 4,
  },
  optionCardRtl: { flexDirection: "row-reverse" },
  optionMain: { flex: 1, minWidth: 0 },
  optionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  optionHint: { marginTop: 3, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, lineHeight: 16 },
  weeksBlock: { gap: 6, paddingTop: 2 },
  weeksInput: { minHeight: 44 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
  },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
