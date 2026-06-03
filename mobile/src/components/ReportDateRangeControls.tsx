import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { DatePickerField } from "./DatePickerField";
import { MonthPickerSheet } from "./MonthPickerSheet";
import {
  firstDayOfMonthISOLocal,
  lastNDaysRangeISO,
  monthRangeISO,
  parseISODateLocal,
  shiftMonthAnchorISOLocal,
} from "../lib/isoDate";
import { formatISODateFull, formatMonthYear } from "../lib/dateFormat";
import { useI18n } from "../context/I18nContext";

type QuickPreset = "7" | "30" | "45" | "60";
type DateMode = "recent" | "month" | "range";

type Props = {
  start: string;
  end: string;
  onChange: (range: { start: string; end: string }) => void;
};

function isFutureMonth(anchor: string): boolean {
  const d = parseISODateLocal(anchor);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth());
}

function isCurrentMonth(anchor: string): boolean {
  const d = parseISODateLocal(anchor);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export function ReportDateRangeControls({ start, end, onChange }: Props) {
  const { t, isRTL, language } = useI18n();
  const rtlRowFlip = isRTL;
  const [mode, setMode] = useState<DateMode>("recent");
  const [recentPreset, setRecentPreset] = useState<QuickPreset>("30");
  const [monthAnchor, setMonthAnchor] = useState(() => firstDayOfMonthISOLocal());
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  const recentOptions = useMemo(
    (): { id: QuickPreset; label: string }[] => [
      { id: "7", label: t("reports.last7Days") },
      { id: "30", label: t("reports.last30Days") },
      { id: "45", label: t("reports.last45Days") },
      { id: "60", label: t("reports.last60Days") },
    ],
    [t]
  );

  const modeOptions = useMemo(
    (): { id: DateMode; label: string }[] => [
      { id: "recent", label: t("reports.modeRecent") },
      { id: "month", label: t("reports.modeMonth") },
      { id: "range", label: t("reports.modeRange") },
    ],
    [t]
  );

  function applyRecent(days: QuickPreset) {
    setRecentPreset(days);
    onChange(lastNDaysRangeISO(Number(days)));
  }

  function applyMonthAnchor(anchor: string) {
    setMonthAnchor(anchor);
    const range = monthRangeISO(anchor);
    if (!range) return;
    onChange(range);
  }

  function switchMode(next: DateMode) {
    setMode(next);
    if (next === "recent") applyRecent(recentPreset);
    else if (next === "month") applyMonthAnchor(monthAnchor);
  }

  function shiftMonth(delta: number) {
    const next = shiftMonthAnchorISOLocal(monthAnchor, delta);
    if (delta > 0 && isFutureMonth(next)) return;
    applyMonthAnchor(next);
  }

  const summary = t("reports.periodShowing")
    .replace("{start}", formatISODateFull(start, language))
    .replace("{end}", formatISODateFull(end, language));

  return (
    <View style={styles.wrap}>
      <Text style={[styles.sectionLabel, isRTL && styles.rtlText]}>{t("reports.periodLabel")}</Text>
      <View style={[styles.modeTrack, rtlRowFlip && styles.modeTrackRtl]}>
        {modeOptions.map((opt) => {
          const on = mode === opt.id;
          return (
            <Pressable
              key={opt.id}
              onPress={() => switchMode(opt.id)}
              style={({ pressed }) => [
                styles.modeChip,
                on && styles.modeChipOn,
                pressed && !on && styles.modeChipPressed,
              ]}
            >
              <Text style={[styles.modeChipTxt, on && styles.modeChipTxtOn]} numberOfLines={1}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "recent" ? (
        <View style={[styles.chipRow, rtlRowFlip && styles.chipRowRtl]}>
          {recentOptions.map((opt) => {
            const on = recentPreset === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => applyRecent(opt.id)}
                style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !on && { opacity: 0.9 }]}
              >
                <Text style={[styles.chipTxt, on && styles.chipTxtOn]} numberOfLines={1}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {mode === "month" ? (
        <View style={[styles.monthRow, rtlRowFlip && styles.monthRowRtl]}>
          <Pressable
            style={({ pressed }) => [styles.monthNav, pressed && styles.monthNavPressed]}
            onPress={() => shiftMonth(-1)}
            accessibilityRole="button"
            accessibilityLabel={t("dashboard.a11yPrevMonth")}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          >
            <Text style={styles.monthChevron}>{"‹"}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.monthPick, pressed && styles.monthPickPressed]}
            onPress={() => setMonthPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t("reports.a11yPickMonth")}
          >
            <Text style={[styles.monthLabel, isRTL && styles.rtlText]} numberOfLines={1}>
              {formatMonthYear(monthAnchor, language)}
            </Text>
            <Text style={styles.monthPickChev}>{"▼"}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.monthNav,
              pressed && !isCurrentMonth(monthAnchor) && styles.monthNavPressed,
              isCurrentMonth(monthAnchor) && styles.monthNavDisabled,
            ]}
            onPress={() => shiftMonth(1)}
            disabled={isCurrentMonth(monthAnchor)}
            accessibilityRole="button"
            accessibilityLabel={t("dashboard.a11yNextMonth")}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          >
            <Text style={[styles.monthChevron, isCurrentMonth(monthAnchor) && styles.monthChevronDisabled]}>{"›"}</Text>
          </Pressable>
        </View>
      ) : null}

      {mode === "range" ? (
        <>
          <DatePickerField
            label={t("common.from")}
            value={start}
            onChange={(iso) => onChange({ start: iso, end })}
            maximumDate={parseISODateLocal(end) ?? undefined}
          />
          <DatePickerField
            label={t("common.to")}
            value={end}
            onChange={(iso) => onChange({ start, end: iso })}
            minimumDate={parseISODateLocal(start) ?? undefined}
            maximumDate={new Date()}
          />
        </>
      ) : null}

      {mode !== "month" ? <Text style={[styles.summary, isRTL && styles.rtlText]}>{summary}</Text> : null}

      <MonthPickerSheet
        visible={monthPickerOpen}
        anchor={monthAnchor}
        onClose={() => setMonthPickerOpen(false)}
        onSelect={applyMonthAnchor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 0 },
  sectionLabel: {
    marginBottom: 8,
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.text,
  },
  rtlText: { textAlign: "right" },
  modeTrack: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: theme.spacing.sm,
  },
  modeTrackRtl: { flexDirection: "row-reverse" },
  modeChip: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 88,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
  },
  modeChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  modeChipPressed: { opacity: 0.88 },
  modeChipTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted, textAlign: "center" },
  modeChipTxtOn: { color: theme.colors.ctaText },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: theme.spacing.sm },
  chipRowRtl: { flexDirection: "row-reverse" },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  chipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  chipTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  chipTxtOn: { color: theme.colors.ctaText },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing.sm,
    paddingVertical: 4,
  },
  monthRowRtl: { flexDirection: "row-reverse" },
  monthNav: {
    minWidth: 40,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  monthNavPressed: { opacity: 0.45 },
  monthNavDisabled: { opacity: 0.35 },
  monthChevron: {
    fontSize: 26,
    fontWeight: "200",
    color: theme.colors.text,
    lineHeight: 28,
    marginTop: -2,
  },
  monthChevronDisabled: { color: theme.colors.textMuted },
  monthPick: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minHeight: 48,
  },
  monthPickPressed: { opacity: 0.9 },
  monthLabel: {
    fontSize: 17,
    fontWeight: "800",
    color: theme.colors.text,
    textAlign: "center",
  },
  monthPickChev: { fontSize: 10, color: theme.colors.textMuted, marginTop: 2 },
  summary: {
    marginTop: theme.spacing.xs,
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
});
