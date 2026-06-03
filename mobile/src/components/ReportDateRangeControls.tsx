import { useEffect, useMemo, useState } from "react";
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
  toISODateLocal,
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

function detectReportRangeState(start: string, end: string): {
  mode: DateMode;
  recentPreset: QuickPreset;
  monthAnchor: string;
} {
  for (const days of ["7", "30", "45", "60"] as QuickPreset[]) {
    const range = lastNDaysRangeISO(Number(days));
    if (range.start === start && range.end === end) {
      return { mode: "recent", recentPreset: days, monthAnchor: firstDayOfMonthISOLocal() };
    }
  }
  const monthStart = parseISODateLocal(start);
  if (monthStart) {
    const anchor = toISODateLocal(new Date(monthStart.getFullYear(), monthStart.getMonth(), 1));
    const range = monthRangeISO(anchor);
    if (range && range.start === start && range.end === end) {
      return { mode: "month", recentPreset: "30", monthAnchor: anchor };
    }
  }
  return { mode: "range", recentPreset: "30", monthAnchor: firstDayOfMonthISOLocal() };
}

export function ReportDateRangeControls({ start, end, onChange }: Props) {
  const { t, isRTL, language } = useI18n();
  const rtlRowFlip = isRTL;
  const initial = useMemo(() => detectReportRangeState(start, end), []);
  const [mode, setMode] = useState<DateMode>(initial.mode);
  const [recentPreset, setRecentPreset] = useState<QuickPreset>(initial.recentPreset);
  const [monthAnchor, setMonthAnchor] = useState(initial.monthAnchor);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  useEffect(() => {
    const detected = detectReportRangeState(start, end);
    setMode(detected.mode);
    setRecentPreset(detected.recentPreset);
    setMonthAnchor(detected.monthAnchor);
  }, [start, end]);

  const recentOptions = useMemo(
    (): { id: QuickPreset; a11y: string }[] => [
      { id: "7", a11y: t("reports.last7Days") },
      { id: "30", a11y: t("reports.last30Days") },
      { id: "45", a11y: t("reports.last45Days") },
      { id: "60", a11y: t("reports.last60Days") },
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
      <View style={[styles.segmentTrack, rtlRowFlip && styles.segmentTrackRtl]}>
        {modeOptions.map((opt, idx) => {
          const on = mode === opt.id;
          const edgeStart = idx === 0;
          const edgeEnd = idx === modeOptions.length - 1;
          return (
            <Pressable
              key={opt.id}
              onPress={() => switchMode(opt.id)}
              style={({ pressed }) => [
                styles.segmentBtn,
                edgeStart && styles.segmentBtnStart,
                edgeEnd && styles.segmentBtnEnd,
                on && styles.segmentBtnOn,
                pressed && !on && styles.segmentBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segmentTxt, on && styles.segmentTxtOn]} numberOfLines={1}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "recent" ? (
        <View style={[styles.presetGrid, rtlRowFlip && styles.presetGridRtl]}>
          {recentOptions.map((opt) => {
            const on = recentPreset === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => applyRecent(opt.id)}
                style={({ pressed }) => [styles.presetCell, on && styles.presetCellOn, pressed && !on && styles.presetCellPressed]}
                accessibilityRole="button"
                accessibilityLabel={opt.a11y}
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.presetNum, on && styles.presetNumOn]}>{opt.id}</Text>
                <Text style={[styles.presetUnit, on && styles.presetUnitOn]} numberOfLines={1}>
                  {t("reports.presetDays")}
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
        <View style={styles.rangeFields}>
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
        </View>
      ) : null}

      {mode !== "month" ? (
        <Text style={[styles.summary, isRTL && styles.rtlText]} numberOfLines={2}>
          {summary}
        </Text>
      ) : null}

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
  rtlText: { textAlign: "right" },
  segmentTrack: {
    flexDirection: "row",
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: 3,
    marginBottom: 10,
  },
  segmentTrackRtl: { flexDirection: "row-reverse" },
  segmentBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderRadius: theme.radius.sm,
  },
  segmentBtnStart: {},
  segmentBtnEnd: {},
  segmentBtnOn: { backgroundColor: theme.colors.cta },
  segmentBtnPressed: { opacity: 0.88 },
  segmentTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted, textAlign: "center" },
  segmentTxtOn: { color: theme.colors.ctaText },
  presetGrid: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 10,
  },
  presetGridRtl: { flexDirection: "row-reverse" },
  presetCell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    minHeight: 52,
  },
  presetCellOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  presetCellPressed: { opacity: 0.9 },
  presetNum: { fontSize: 17, fontWeight: "900", color: theme.colors.text, lineHeight: 20 },
  presetNumOn: { color: theme.colors.ctaText },
  presetUnit: { marginTop: 2, fontSize: 10, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", letterSpacing: 0.3 },
  presetUnitOn: { color: theme.colors.ctaText, opacity: 0.85 },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    paddingVertical: 2,
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
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minHeight: 48,
  },
  monthPickPressed: { opacity: 0.9 },
  monthLabel: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
    textAlign: "center",
  },
  monthPickChev: { fontSize: 10, color: theme.colors.textMuted, marginTop: 2 },
  rangeFields: { marginBottom: 4 },
  summary: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 17,
  },
});
