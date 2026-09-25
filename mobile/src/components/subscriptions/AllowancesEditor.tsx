import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { SUBSCRIPTION_TIERS, tierLabelKey, type WeeklyLimits } from "../../lib/subscriptions";

type Props = {
  value: WeeklyLimits;
  onChange: (next: WeeklyLimits) => void;
  label: string;
  hint?: string;
};

/**
 * 7 independent weekly-allowance inputs (Personal…Group), one row per subscription_tier. Always
 * rendered as its own section, visually and logically separate from any duration/end-date field —
 * has_no_end_date (backend, generated) never appears here and never affects these values.
 */
export function AllowancesEditor({ value, onChange, label, hint }: Props) {
  const { t, isRTL } = useI18n();

  function setTier(tier: (typeof SUBSCRIPTION_TIERS)[number], raw: string) {
    const digitsOnly = raw.replace(/[^0-9]/g, "");
    const n = digitsOnly === "" ? 0 : Math.min(999, Number.parseInt(digitsOnly, 10));
    onChange({ ...value, [tier]: n });
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtl]}>{label}</Text>
      {hint ? <Text style={[styles.hint, isRTL && styles.rtl]}>{hint}</Text> : null}
      <View style={styles.rows}>
        {SUBSCRIPTION_TIERS.map((tier) => (
          <View key={tier} style={[styles.row, isRTL && styles.rowRtl]}>
            <Text style={[styles.tierLabel, isRTL && styles.rtl]} numberOfLines={1}>
              {t(tierLabelKey(tier))}
            </Text>
            <TextInput
              value={String(value[tier] ?? 0)}
              onChangeText={(txt) => setTier(tier, txt)}
              keyboardType="number-pad"
              inputMode="numeric"
              style={[styles.input, isRTL && styles.inputRtl]}
              accessibilityLabel={t(tierLabelKey(tier))}
              maxLength={3}
            />
            <Text style={[styles.perWeek, isRTL && styles.rtl]}>{t("subscriptions.perWeek")}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  hint: { fontSize: 12, fontWeight: "500", color: theme.colors.textSoft, marginBottom: 4, lineHeight: 17 },
  rows: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowRtl: { flexDirection: "row-reverse" },
  tierLabel: { flex: 1, fontSize: 14, fontWeight: "600", color: theme.colors.text },
  input: {
    width: 64,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 10,
    fontSize: 15,
    textAlign: "center",
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  inputRtl: { textAlign: "center" },
  perWeek: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, minWidth: 56 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
