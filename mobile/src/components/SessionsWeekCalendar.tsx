import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { SessionAgendaCardContent } from "./SessionAgendaCardContent";
import { useI18n } from "../context/I18nContext";

export type SessionsWeekItem = {
  key: string;
  session_date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  /** Shown on the card (e.g. 18:00–19:00). If omitted, only start_time is shown. */
  timeLabel?: string;
  trainerName?: string;
  /** One-line fallback when not using staff pills (e.g. athlete). */
  subtitle?: string;
  signedUpCount?: number;
  maxParticipants?: number;
  /** Left accent (#RRGGBB). */
  accentColor?: string;
  /** Show Listed/Hidden + Open/Closed tags (staff). */
  showStaffSessionLabels?: boolean;
  isHidden?: boolean;
  isOpenForRegistration?: boolean;
  /** For staff: assigned coach (edit/delete only when matches current user for coaches). */
  coachId?: string;
  onPress?: () => void;
};

type Props = {
  items: SessionsWeekItem[];
  isLoading?: boolean;
  emptyLabel?: string;
  /** Tap a day column (header or empty area; session chips still open the session). */
  onDayPress?: (isoDate: string) => void;
  /** Reports the currently displayed week range (Sun–Sat), in ISO dates. */
  onWeekChange?: (weekStartIso: string, weekEndIso: string) => void;
};

const DAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

function addDays(d: Date, days: number) {
  const next = new Date(d);
  next.setDate(d.getDate() + days);
  return next;
}

function startOfWeekSunday(d: Date) {
  const next = new Date(d);
  // Make DST-safe by keeping midday time.
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function dateToISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatWeekLabel(start: Date, end: Date, locale: string) {
  // Month + day only (no year): keep compact range as-is for same calendar year span.
  const optsShort: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const useYear = start.getFullYear() !== end.getFullYear();
  const localeYear = locale === "he-IL" ? "he-IL" : "en-GB";
  const fmtWithYear = (x: Date) =>
    x.toLocaleDateString(localeYear, { day: "numeric", month: "short", year: "numeric" });
  const fmtShort = (x: Date) => x.toLocaleDateString(locale, optsShort);
  const fmtA = (x: Date) => (useYear ? fmtWithYear(x) : fmtShort(x));
  return `${fmtA(start)} - ${fmtA(end)}`;
}

export function SessionsWeekCalendar({ items, isLoading, emptyLabel, onDayPress, onWeekChange }: Props) {
  const [weekOffset, setWeekOffset] = useState(0);
  const { language, t, isRTL } = useI18n();
  const locale = language === "he" ? "he-IL" : "en-US";
  const dayNames = language === "he" ? DAY_NAMES_HE : DAY_NAMES_EN;

  /** Recomputed each render so “today” stays correct if the week view stays open past midnight. */
  const todayIso = dateToISODate(new Date());

  const weekStart = useMemo(() => {
    const base = startOfWeekSunday(new Date());
    return addDays(base, weekOffset * 7);
  }, [weekOffset]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => {
      const d = addDays(weekStart, i);
      return {
        date: d,
        iso: dateToISODate(d),
      };
    });
  }, [weekStart]);

  useEffect(() => {
    const startIso = weekDays[0]?.iso;
    const endIso = weekDays[6]?.iso;
    if (startIso && endIso) onWeekChange?.(startIso, endIso);
  }, [weekDays, onWeekChange]);

  const { byDate, weekItemsCount } = useMemo(() => {
    const map = new Map<string, SessionsWeekItem[]>();
    for (const it of items) {
      const list = map.get(it.session_date) ?? [];
      list.push(it);
      map.set(it.session_date, list);
    }
    // Sort each day's sessions by time for stable UX.
    for (const [k, list] of map.entries()) {
      list.sort((a, b) => {
        const t = a.start_time.localeCompare(b.start_time);
        if (t !== 0) return t;
        return (a.trainerName ?? "").localeCompare(b.trainerName ?? "");
      });
      map.set(k, list);
    }

    const startIso = weekDays[0]?.iso;
    const endIso = weekDays[6]?.iso;
    const count =
      !!startIso && !!endIso
        ? weekDays.reduce((acc, d) => {
            if (d.iso < startIso || d.iso > endIso) return acc;
            return acc + (map.get(d.iso) ?? []).length;
          }, 0)
        : 0;

    return { byDate: map, weekItemsCount: count };
  }, [items, weekDays]);

  const weekLabel = useMemo(() => {
    const start = weekDays[0]?.date ?? weekStart;
    const end = weekDays[6]?.date ?? weekStart;
    return formatWeekLabel(start, end, locale);
  }, [weekDays, weekStart, locale]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={styles.loadingText}>{t("common.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {/*
        Under `dir=rtl` (Hebrew web) or I18nManager RTL, flex `row` still mirrors main axis,
        which swaps the two buttons. Isolate this bar as LTR so prev stays screen-left with `<`.
      */}
      <View style={styles.header}>
        <Pressable
          onPress={() => setWeekOffset((o) => o - 1)}
          style={({ pressed }) => [styles.navBtn, pressed && styles.navBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel={language === "he" ? "שבוע קודם" : "Previous week"}
        >
          <Text style={styles.navChevron}>{"←"}</Text>
        </Pressable>
        <Text style={styles.weekTitle} numberOfLines={1}>
          {weekLabel}
        </Text>
        <Pressable
          onPress={() => setWeekOffset((o) => o + 1)}
          style={({ pressed }) => [styles.navBtn, pressed && styles.navBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel={language === "he" ? "שבוע הבא" : "Next week"}
        >
          <Text style={styles.navChevron}>{"→"}</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.scrollerContent, isRTL && styles.scrollerContentRtl]}
          style={styles.scroller}
        >
          {weekDays.map((d) => {
            const dayList = byDate.get(d.iso) ?? [];
            const count = dayList.length;
            const isToday = d.iso === todayIso;
            return (
              <Pressable
                key={d.iso}
                onPress={() => onDayPress?.(d.iso)}
                disabled={!onDayPress}
                style={({ pressed }) => [
                  styles.dayCol,
                  isToday && styles.dayColToday,
                  pressed && onDayPress && styles.dayColPressed,
                ]}
                accessibilityLabel={
                  isToday
                    ? language === "he"
                      ? `${dayNames[d.date.getDay()]} ${d.date.getDate()}, היום`
                      : `Today, ${dayNames[d.date.getDay()]} ${d.date.getDate()}`
                    : `${dayNames[d.date.getDay()]} ${d.date.getDate()}`
                }
              >
                <View style={styles.dayHeaderBox}>
                  <Text style={styles.dayName}>{dayNames[d.date.getDay()]}</Text>
                  <Text style={[styles.dayNum, isToday && styles.dayNumToday]}>{d.date.getDate()}</Text>
                  <Text style={[styles.dayMonth, isToday && styles.dayMonthToday]}>
                    {d.date.toLocaleDateString(locale, { month: "short" })}
                  </Text>
                  {count > 0 ? (
                    <View style={styles.countPill}>
                      <Text style={styles.countPillTxt}>{count}</Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.dayItems}>
                  {dayList.map((it) => (
                    <Pressable
                      key={it.key}
                      onPress={it.onPress}
                      disabled={!it.onPress}
                      style={({ pressed }) => [
                        styles.card,
                        pressed && it.onPress && { opacity: 0.9 },
                      ]}
                    >
                      <SessionAgendaCardContent item={it} compact />
                    </Pressable>
                  ))}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {weekItemsCount === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{emptyLabel ?? (language === "he" ? "אין אימונים בשבוע זה." : "No sessions this week.")}</Text>
            <View style={styles.emptyActions}>
              <Pressable style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.9 }]} onPress={() => setWeekOffset((o) => o - 1)}>
                <Text style={styles.emptyBtnTxt}>{language === "he" ? "שבוע קודם" : "Prev week"}</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.9 }]} onPress={() => setWeekOffset((o) => o + 1)}>
                <Text style={styles.emptyBtnTxt}>{language === "he" ? "שבוע הבא" : "Next week"}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingBottom: theme.spacing.xl },
  header: {
    flexDirection: "row",
    /** Override document / parent RTL so flex order is [prev][title][next] left-to-right. */
    writingDirection: "ltr",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  weekTitle: {
    flex: 1,
    textAlign: "center",
    fontWeight: "700",
    fontSize: 15,
    color: theme.colors.text,
    letterSpacing: 0.2,
  },
  navBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  navBtnPressed: { opacity: 0.88 },
  /** LTR glyphs so `<` / `>` are not bidi-mirrored inside Hebrew UI. */
  navChevron: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    writingDirection: "ltr",
  },
  body: { width: "100%", alignItems: "stretch" },
  /** When the 7 day columns are narrower than the screen, center them; when wider (small phones), scroll still works. */
  scroller: { width: "100%" },
  scrollerContent: {
    flexDirection: "row",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 2,
    ...(Platform.OS === "web" ? ({ minWidth: "100%" } as const) : {}),
  },
  scrollerContentRtl: { flexDirection: "row-reverse" },
  dayCol: {
    width: 112,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    minHeight: 240,
    borderWidth: 2,
    borderColor: "transparent",
  },
  /** Today: CTA-colored frame + soft glow (theme accent on dark UI). */
  dayColToday: {
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.surface,
    ...Platform.select({
      ios: {
        shadowColor: theme.colors.cta,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.28,
        shadowRadius: 12,
      },
      android: {
        elevation: 5,
        shadowColor: theme.colors.cta,
      },
      default: {
        // RN Web
        boxShadow: `0 0 0 1px ${theme.colors.cta}, 0 0 20px rgba(244,244,245,0.12)`,
      },
    }),
  },
  dayColPressed: { opacity: 0.88 },
  dayHeaderBox: { alignItems: "center", justifyContent: "center", marginBottom: theme.spacing.sm, position: "relative" },
  countPill: {
    marginTop: 6,
    minWidth: 24,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  countPillTxt: { color: theme.colors.ctaText, fontSize: 11, fontWeight: "800", textAlign: "center" },
  dayName: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  dayNum: { fontSize: 22, fontWeight: "800", color: theme.colors.text, lineHeight: 24 },
  dayNumToday: { color: theme.colors.cta },
  dayMonth: { fontSize: 11, fontWeight: "600", color: theme.colors.textMuted, marginTop: 2 },
  dayMonthToday: { color: theme.colors.text, fontWeight: "700" },
  dayItems: { gap: 8, flex: 1 },
  card: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  empty: { paddingTop: theme.spacing.md, paddingBottom: theme.spacing.lg, alignItems: "center" },
  emptyText: { textAlign: "center", color: theme.colors.textSoft, maxWidth: 320 },
  emptyActions: { flexDirection: "row", writingDirection: "ltr", gap: 10, marginTop: 14 },
  emptyBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  emptyBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 13 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing.lg },
  loadingText: { marginTop: 12, color: theme.colors.textMuted },
});

