import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AnimatedOptionExpand } from "./AnimatedOptionExpand";

type Props = {
  value: string;
  onChangeValue: (v: string) => void;
  /** Default coach_capacity_pricing rate for the session's current registered headcount. */
  defaultRateIls: number | null;
  hasCustomOnServer: boolean;
  serverCustomRateIls?: number | null;
  /** When set, shows Apply (session view). Omit when parent saves on form submit. */
  onApply?: () => void;
  onClear?: () => void;
  applyBusy?: boolean;
  disabled?: boolean;
  /** `form` = inside edit/create `sf.sections` (spacing from parent gap). */
  layout?: "form" | "standalone";
};

function formatIls(n: number, language: string): string {
  const rounded = Math.round(n * 100) / 100;
  const s = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return language === "he" ? `${s} ₪` : `₪${s}`;
}

function resolveDisplayRate(
  value: string,
  defaultRateIls: number | null,
  hasCustomOnServer: boolean,
  serverCustomRateIls: number | null | undefined
): { amount: number | null; isCustom: boolean } {
  const trimmed = value.trim();
  if (trimmed !== "") {
    const n = parseFloat(trimmed.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) {
      const isCustom = hasCustomOnServer || (defaultRateIls == null || n !== defaultRateIls);
      return { amount: n, isCustom };
    }
  }
  if (hasCustomOnServer && serverCustomRateIls != null && Number.isFinite(Number(serverCustomRateIls))) {
    return { amount: Number(serverCustomRateIls), isCustom: true };
  }
  if (defaultRateIls != null) return { amount: defaultRateIls, isCustom: false };
  return { amount: null, isCustom: false };
}

export function SessionCoachRateField({
  value,
  onChangeValue,
  defaultRateIls,
  hasCustomOnServer,
  serverCustomRateIls,
  onApply,
  onClear,
  applyBusy,
  disabled,
  layout = "standalone",
}: Props) {
  const { t, isRTL, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const showApply = !!onApply;

  const { amount, isCustom } = useMemo(
    () => resolveDisplayRate(value, defaultRateIls, hasCustomOnServer, serverCustomRateIls),
    [value, defaultRateIls, hasCustomOnServer, serverCustomRateIls]
  );

  const summaryText =
    amount != null
      ? isCustom
        ? t("managerSession.coachRateCustomShort").replace("{amount}", formatIls(amount, language))
        : t("managerSession.coachRateDefaultShort").replace("{amount}", formatIls(amount, language))
      : t("managerSession.coachRateNoDefault");

  return (
    <View style={layout === "form" ? styles.cardForm : styles.cardStandalone}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.header, isRTL && styles.headerRtl, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${t("managerSession.coachRateTitle")}. ${summaryText}`}
      >
        <Text style={[styles.title, isRTL && styles.rtlText]}>{t("managerSession.coachRateTitle")}</Text>
        <View style={[styles.headerEnd, isRTL && styles.headerEndRtl]}>
          <Text style={[styles.summary, isRTL && styles.rtlText]} numberOfLines={1}>
            {summaryText}
          </Text>
          <Text style={styles.chevron}>{expanded ? "▴" : "▾"}</Text>
        </View>
      </Pressable>

      <AnimatedOptionExpand open={expanded}>
        <View style={styles.body}>
          <Text style={[styles.hierarchyHint, isRTL && styles.rtlText]}>
            {t("managerSession.coachRateHierarchy")}
          </Text>
          {defaultRateIls != null ? (
            <Text style={[styles.tierHint, isRTL && styles.rtlText]}>
              {t("managerSession.coachRateDefaultShort").replace("{amount}", formatIls(defaultRateIls, language))}
            </Text>
          ) : null}
          <View style={[styles.inputRow, isRTL && styles.inputRowRtl]}>
            <TextInput
              style={[styles.input, isRTL && styles.inputRtl, disabled && styles.inputDisabled]}
              value={value}
              onChangeText={onChangeValue}
              keyboardType="decimal-pad"
              placeholder={
                defaultRateIls != null ? String(defaultRateIls) : language === "he" ? "תעריף" : "Rate"
              }
              placeholderTextColor={theme.colors.placeholderOnLight}
              editable={!disabled && !applyBusy}
            />
            <Text style={styles.currency}>₪</Text>
            {showApply ? (
              <Pressable
                onPress={onApply}
                disabled={disabled || applyBusy}
                style={({ pressed }) => [
                  styles.applyBtn,
                  (disabled || applyBusy) && styles.applyBtnDisabled,
                  pressed && !disabled && !applyBusy && { opacity: 0.88 },
                ]}
                accessibilityRole="button"
              >
                <Text style={styles.applyBtnTxt}>
                  {applyBusy ? "…" : t("managerSession.coachRateApply")}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {hasCustomOnServer && onClear ? (
            <Pressable
              onPress={onClear}
              disabled={disabled || applyBusy}
              style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.88 }]}
              accessibilityRole="button"
            >
              <Text style={[styles.clearBtnTxt, isRTL && styles.rtlText]}>
                {t("managerSession.coachRateClear")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </AnimatedOptionExpand>
    </View>
  );
}

const cardBase = {
  padding: theme.spacing.md,
  borderRadius: theme.radius.lg,
  borderWidth: 1,
  borderColor: theme.colors.borderMuted,
  backgroundColor: theme.colors.surface,
} as const;

const styles = StyleSheet.create({
  cardForm: {
    ...cardBase,
  },
  cardStandalone: {
    ...cardBase,
    marginTop: theme.spacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minHeight: 36,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: {
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.text,
    flexShrink: 0,
  },
  headerEnd: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    minWidth: 0,
  },
  headerEndRtl: { flexDirection: "row-reverse", justifyContent: "flex-start" },
  summary: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textMuted,
    flexShrink: 1,
  },
  chevron: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textMuted,
  },
  body: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  hierarchyHint: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 15,
    marginBottom: 6,
  },
  tierHint: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textMuted,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inputRowRtl: { flexDirection: "row-reverse" },
  input: {
    flex: 1,
    minWidth: 72,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceElevated,
  },
  inputRtl: { textAlign: "right" },
  inputDisabled: { opacity: 0.6 },
  currency: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  applyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  applyBtnDisabled: { opacity: 0.5 },
  applyBtnTxt: {
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.ctaText,
  },
  clearBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  clearBtnTxt: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.cta,
  },
  rtlText: { writingDirection: "rtl", textAlign: "right" },
});
