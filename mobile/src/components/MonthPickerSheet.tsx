import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";
import { formatMonthYear } from "../lib/dateFormat";
import { appLocale } from "../lib/appLocale";
import { useI18n } from "../context/I18nContext";
import type { LanguageCode } from "../i18n/translations";

const MIN_YEAR = 2020;

type Props = {
  visible: boolean;
  anchor: string;
  onClose: () => void;
  onSelect: (anchor: string) => void;
};

function monthNames(language: LanguageCode): string[] {
  return Array.from({ length: 12 }, (_, i) =>
    new Date(2024, i, 1).toLocaleDateString(appLocale(language), { month: "short" })
  );
}

function isFutureMonth(year: number, monthIndex: number): boolean {
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && monthIndex > now.getMonth());
}

export function MonthPickerSheet({ visible, anchor, onClose, onSelect }: Props) {
  const { t, language, isRTL } = useI18n();
  const maxYear = new Date().getFullYear();
  const parsed = parseISODateLocal(anchor);
  const [draftYear, setDraftYear] = useState(parsed?.getFullYear() ?? maxYear);
  const [draftMonth, setDraftMonth] = useState(parsed?.getMonth() ?? new Date().getMonth());

  useEffect(() => {
    if (!visible) return;
    const d = parseISODateLocal(anchor);
    const today = new Date();
    setDraftYear(d?.getFullYear() ?? today.getFullYear());
    setDraftMonth(d?.getMonth() ?? today.getMonth());
  }, [visible, anchor]);

  const months = useMemo(() => monthNames(language), [language]);

  function pickMonth(monthIndex: number) {
    if (isFutureMonth(draftYear, monthIndex)) return;
    const iso = toISODateLocal(new Date(draftYear, monthIndex, 1));
    onSelect(iso);
    onClose();
  }

  function confirmCurrentDraft() {
    if (isFutureMonth(draftYear, draftMonth)) return;
    onSelect(toISODateLocal(new Date(draftYear, draftMonth, 1)));
    onClose();
  }

  const canPrevYear = draftYear > MIN_YEAR;
  const canNextYear = draftYear < maxYear;

  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="sheet"
      backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
      maxHeightPct={0.72}
    >
      <View style={styles.sheet}>
        <View style={[styles.toolbar, isRTL && styles.toolbarRtl]}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.tbMuted}>{t("common.cancel")}</Text>
          </Pressable>
          <Text style={styles.tbTitle}>{t("reports.pickMonthTitle")}</Text>
          <Pressable onPress={confirmCurrentDraft} hitSlop={12}>
            <Text style={styles.tbCta}>{t("common.ok")}</Text>
          </Pressable>
        </View>

        <View style={[styles.yearRow, isRTL && styles.yearRowRtl]}>
          <Pressable
            style={({ pressed }) => [styles.yearNav, !canPrevYear && styles.yearNavDisabled, pressed && canPrevYear && styles.yearNavPressed]}
            onPress={() => canPrevYear && setDraftYear((y) => y - 1)}
            disabled={!canPrevYear}
            accessibilityLabel={t("reports.a11yPrevYear")}
          >
            <Text style={[styles.yearChevron, !canPrevYear && styles.yearChevronDisabled]}>{"‹"}</Text>
          </Pressable>
          <Text style={styles.yearLabel}>{draftYear}</Text>
          <Pressable
            style={({ pressed }) => [styles.yearNav, !canNextYear && styles.yearNavDisabled, pressed && canNextYear && styles.yearNavPressed]}
            onPress={() => canNextYear && setDraftYear((y) => y + 1)}
            disabled={!canNextYear}
            accessibilityLabel={t("reports.a11yNextYear")}
          >
            <Text style={[styles.yearChevron, !canNextYear && styles.yearChevronDisabled]}>{"›"}</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.gridWrap} keyboardShouldPersistTaps="handled">
          <View style={[styles.grid, isRTL && styles.gridRtl]}>
            {months.map((label, monthIndex) => {
              const future = isFutureMonth(draftYear, monthIndex);
              const highlighted = monthIndex === draftMonth;
              return (
                <Pressable
                  key={label}
                  style={({ pressed }) => [
                    styles.monthCell,
                    highlighted && styles.monthCellOn,
                    future && styles.monthCellDisabled,
                    pressed && !future && styles.monthCellPressed,
                  ]}
                  onPress={() => {
                    setDraftMonth(monthIndex);
                    pickMonth(monthIndex);
                  }}
                  disabled={future}
                >
                  <Text
                    style={[
                      styles.monthCellTxt,
                      highlighted && styles.monthCellTxtOn,
                      future && styles.monthCellTxtDisabled,
                    ]}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        <Text style={[styles.preview, isRTL && styles.rtlText]}>
          {formatMonthYear(toISODateLocal(new Date(draftYear, draftMonth, 1)), language)}
        </Text>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingBottom: theme.spacing.lg },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  toolbarRtl: { flexDirection: "row-reverse" },
  tbMuted: { fontSize: 16, fontWeight: "600", color: theme.colors.textMuted, minWidth: 64 },
  tbTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "800", color: theme.colors.text },
  tbCta: { fontSize: 16, fontWeight: "800", color: theme.colors.cta, minWidth: 64, textAlign: "right" },
  yearRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  yearRowRtl: { flexDirection: "row-reverse" },
  yearNav: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  yearNavPressed: { opacity: 0.45 },
  yearNavDisabled: { opacity: 0.35 },
  yearChevron: { fontSize: 28, fontWeight: "200", color: theme.colors.text, lineHeight: 30 },
  yearChevronDisabled: { color: theme.colors.textMuted },
  yearLabel: { fontSize: 22, fontWeight: "900", color: theme.colors.text, minWidth: 80, textAlign: "center" },
  gridWrap: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  gridRtl: { flexDirection: "row-reverse" },
  monthCell: {
    width: "30%",
    minWidth: 88,
    maxWidth: 120,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
  },
  monthCellOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  monthCellDisabled: { opacity: 0.35 },
  monthCellPressed: { opacity: 0.88 },
  monthCellTxt: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  monthCellTxtOn: { color: theme.colors.ctaText },
  monthCellTxtDisabled: { color: theme.colors.textMuted },
  preview: {
    textAlign: "center",
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textMuted,
    paddingHorizontal: theme.spacing.md,
  },
  rtlText: { textAlign: "right" },
});
