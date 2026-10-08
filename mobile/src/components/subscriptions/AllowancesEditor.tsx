import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "../AppIcon";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { SUBSCRIPTION_TIERS, tierLabelKey, type WeeklyLimits } from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";

type Props = {
  value: WeeklyLimits;
  onChange: (next: WeeklyLimits) => void;
  label: string;
  hint?: string;
};

const MIN_WEEKLY_LIMIT = 0;
const MAX_WEEKLY_LIMIT = 999;

/**
 * 7 independent weekly-allowance inputs (Personal…Group), one row per subscription_tier. Always
 * rendered as its own section, visually and logically separate from any duration/end-date field —
 * has_no_end_date (backend, generated) never appears here and never affects these values.
 */
export function AllowancesEditor({ value, onChange, label, hint }: Props) {
  const { t, isRTL } = useI18n();

  function setTier(tier: (typeof SUBSCRIPTION_TIERS)[number], n: number) {
    const clamped = Math.max(MIN_WEEKLY_LIMIT, Math.min(MAX_WEEKLY_LIMIT, n));
    onChange({ ...value, [tier]: clamped });
  }

  function setTierFromText(tier: (typeof SUBSCRIPTION_TIERS)[number], raw: string) {
    const digitsOnly = raw.replace(/[^0-9]/g, "");
    const n = digitsOnly === "" ? 0 : Number.parseInt(digitsOnly, 10);
    setTier(tier, n);
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtl]}>{label}</Text>
      {hint ? <Text style={[styles.hint, isRTL && styles.rtl]}>{hint}</Text> : null}
      <View style={styles.rows}>
        {SUBSCRIPTION_TIERS.map((tier) => {
          const current = value[tier] ?? 0;
          const tierLabel = t(tierLabelKey(tier));
          return (
            <View key={tier} style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl]}>
              <Text style={[styles.tierLabel, isRTL && styles.rtl]} numberOfLines={1}>
                {tierLabel}
              </Text>
              {/* Deliberately NOT mirrored for RTL: a +/- stepper is a mathematical control
                  (like iOS's native stepper), not a reading-direction element — keeping minus
                  on the left and plus on the right in both languages also avoids fragile
                  corner-radius/border-seam mirroring for no real benefit. */}
              <View style={styles.stepper}>
                <Pressable
                  onPress={() => setTier(tier, current - 1)}
                  disabled={current <= MIN_WEEKLY_LIMIT}
                  style={styles.stepperHit}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("subscriptions.decreaseAllowance")} ${tierLabel}`}
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.stepperButton,
                        current <= MIN_WEEKLY_LIMIT && styles.stepperButtonDisabled,
                        pressed && current > MIN_WEEKLY_LIMIT && styles.stepperButtonPressed,
                      ]}
                    >
                      <AppIcon name="remove" size="sm" color={theme.colors.text} />
                    </View>
                  )}
                </Pressable>
                <TextInput
                  value={String(current)}
                  onChangeText={(txt) => setTierFromText(tier, txt)}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  style={[styles.input, isRTL && styles.inputRtl]}
                  accessibilityLabel={tierLabel}
                  maxLength={3}
                />
                <Pressable
                  onPress={() => setTier(tier, current + 1)}
                  disabled={current >= MAX_WEEKLY_LIMIT}
                  style={styles.stepperHit}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("subscriptions.increaseAllowance")} ${tierLabel}`}
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.stepperButton,
                        current >= MAX_WEEKLY_LIMIT && styles.stepperButtonDisabled,
                        pressed && current < MAX_WEEKLY_LIMIT && styles.stepperButtonPressed,
                      ]}
                    >
                      <AppIcon name="add" size="sm" color={theme.colors.text} />
                    </View>
                  )}
                </Pressable>
              </View>
            </View>
          );
        })}
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
  tierLabel: { flex: 1, ...theme.typography.secondary, color: theme.colors.text },
  // direction ltr: on web the browser would otherwise mirror the row in Hebrew (see the note at the stepper).
  stepper: { flexDirection: "row", alignItems: "center", gap: 8, direction: "ltr" },
  // 44px hit area around the 32px circle (padding cancelled by a negative margin; hitSlop is ignored on web).
  stepperHit: { padding: 6, margin: -6 },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
  },
  stepperButtonPressed: { backgroundColor: theme.colors.accentLight, borderColor: theme.colors.borderInput },
  stepperButtonDisabled: { opacity: 0.3 },
  input: {
    width: 52,
    height: theme.controls.minTouch,
    borderRadius: theme.radius.md,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
    paddingVertical: 0,
  },
  inputRtl: { textAlign: "center" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
