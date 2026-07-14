import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";
import { EmptyState } from "./EmptyState";
import { SessionAgendaCardContent } from "./SessionAgendaCardContent";
import { SessionCardSkeleton } from "./SessionCardSkeleton";
import { AthleteWaitlistInviteStripe, AthleteWaitlistJoinedStripe } from "./AthleteWaitlistInviteStripe";
import { useI18n } from "../context/I18nContext";
import { getSessionTemporalPhase } from "../lib/sessionTime";
import type { StudioCalendarNote } from "../lib/studioCalendarNotes";
import { studioNoteCoversDate } from "../lib/studioCalendarNotes";
import { studioCalendarNoteAccent } from "../lib/studioCalendarNoteAccent";

export type SessionsWeekItem = {
  key: string;
  session_date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  /** Duration for live / ended styling; defaults to 60 in consumers if omitted. */
  durationMinutes?: number;
  /** Shown on the card (e.g. 18:00–19:00). If omitted, only start_time is shown. */
  timeLabel?: string;
  /** Optional small badge shown next to time (e.g. "7/12"). */
  timeBadgeText?: string;
  /** Optional second badge shown next to time (e.g. "WL 3"). */
  timeBadgeText2?: string;
  trainerName?: string;
  /** One-line fallback when not using staff pills (e.g. athlete). */
  subtitle?: string;
  /** When true, allow subtitle to wrap without ellipsis. */
  subtitleUnclamped?: boolean;
  signedUpCount?: number;
  maxParticipants?: number;
  /** Left accent (#RRGGBB) — trainer calendar color. */
  accentColor?: string;
  isKickbox?: boolean;
  /** Staff only: session is part of an active weekly series (not detached). */
  isRecurringSeries?: boolean;
  /** Show Listed/Hidden + Open/Closed tags (staff). */
  showStaffSessionLabels?: boolean;
  isHidden?: boolean;
  isOpenForRegistration?: boolean;
  /** When true, don't dim past/hidden sessions in the grid. */
  hideTemporalDimming?: boolean;
  /** When true, hide open/closed indicators (chips / state bar). */
  hideRegistrationState?: boolean;
  /** Staff-only: waitlist count for the session (shown when full). */
  waitlistCount?: number;
  /** For staff: assigned coach (edit/delete only when matches current user for coaches). */
  coachId?: string;
  onPress?: () => void;
  /** Athlete: full session — join waitlist without opening detail first. */
  onJoinWaitlist?: () => void | Promise<void>;
  waitlistJoining?: boolean;
  /** Athlete: already on waitlist for this session (shows confirmation strip when full). */
  athleteOnWaitlist?: boolean;
  /** Athlete: active registration for this session — calendar shows registered styling, hides spots left. */
  athleteRegistered?: boolean;
};

type Props = {
  items: SessionsWeekItem[];
  isLoading?: boolean;
  emptyLabel?: string;
  /** Tap a day column (header or empty area; session chips still open the session). */
  onDayPress?: (isoDate: string) => void;
  /** When true, hide prev/next week controls (e.g. athlete browse is a single fixed week). */
  hideWeekNavigation?: boolean;
  /** Reports the currently displayed week range (Sun–Sat), in ISO dates. */
  onWeekChange?: (weekStartIso: string, weekEndIso: string) => void;
  /**
   * When both are provided, week navigation is controlled by the parent so the visible week
   * survives returning from session detail / remounts. Offset is in steps of 7 days from the
   * Sunday-start week that contains “today” (same base as internal state).
   */
  weekOffset?: number;
  onWeekOffsetChange?: (next: number) => void;
  /** When set, prev week is disabled at this offset (inclusive). */
  minWeekOffset?: number;
  /** When set, next week is disabled at this offset (inclusive). */
  maxWeekOffset?: number;
  /** Studio-wide notes overlapping the visible week (from parent fetch). */
  calendarNotes?: StudioCalendarNote[];
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

export function SessionsWeekCalendar({
  items,
  isLoading,
  emptyLabel,
  onDayPress,
  onWeekChange,
  weekOffset: weekOffsetProp,
  onWeekOffsetChange,
  hideWeekNavigation,
  minWeekOffset,
  maxWeekOffset,
  calendarNotes,
}: Props) {
  const [internalWeekOffset, setInternalWeekOffset] = useState(0);
  const controlled = onWeekOffsetChange != null;
  const weekOffset = controlled ? (weekOffsetProp ?? 0) : internalWeekOffset;

  const canGoPrev = minWeekOffset == null || weekOffset > minWeekOffset;
  const canGoNext = maxWeekOffset == null || weekOffset < maxWeekOffset;

  const scrollRef = useRef<ScrollView>(null);
  /** Set by bumpWeek, consumed by the effect below once the new week's days are in place. */
  const pendingScrollDirRef = useRef<1 | -1 | null>(null);

  function bumpWeek(delta: number) {
    const next = weekOffset + delta;
    if (minWeekOffset != null && next < minWeekOffset) return;
    if (maxWeekOffset != null && next > maxWeekOffset) return;
    pendingScrollDirRef.current = delta > 0 ? 1 : -1;
    if (controlled) {
      onWeekOffsetChange?.(next);
    } else {
      setInternalWeekOffset(next);
    }
  }

  /** Periodic refresh so “live” / “ended” styling updates without navigating away. */
  const [, setTemporalTick] = useState(0);
  const { language, t, isRTL } = useI18n();
  const locale = language === "he" ? "he-IL" : "en-US";
  const dayNames = language === "he" ? DAY_NAMES_HE : DAY_NAMES_EN;

  /** Recomputed each render so “today” stays correct if the week view stays open past midnight. */
  const todayIso = dateToISODate(new Date());

  useEffect(() => {
    const dir = pendingScrollDirRef.current;
    if (dir == null) return;
    pendingScrollDirRef.current = null;
    // Column order is row-reversed under RTL, so "start of row" and "start of week" swap sides.
    const scrollToWeekStart = dir > 0 ? !isRTL : isRTL;
    if (scrollToWeekStart) {
      scrollRef.current?.scrollTo({ x: 0, animated: true });
    } else {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [weekOffset, isRTL]);

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

  const weekStartIso = weekDays[0]?.iso ?? "";
  const weekEndIso = weekDays[6]?.iso ?? "";
  const onWeekChangeRef = useRef(onWeekChange);
  onWeekChangeRef.current = onWeekChange;
  const lastReportedWeekRef = useRef<{ start: string; end: string } | null>(null);

  useEffect(() => {
    if (!weekStartIso || !weekEndIso) return;
    const cb = onWeekChangeRef.current;
    if (!cb) return;
    const prev = lastReportedWeekRef.current;
    if (prev && prev.start === weekStartIso && prev.end === weekEndIso) return;
    lastReportedWeekRef.current = { start: weekStartIso, end: weekEndIso };
    cb(weekStartIso, weekEndIso);
  }, [weekStartIso, weekEndIso]);

  useEffect(() => {
    const id = setInterval(() => setTemporalTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

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

  const notesByDate = useMemo(() => {
    const m = new Map<string, StudioCalendarNote[]>();
    if (!calendarNotes?.length) return m;
    for (const d of weekDays) {
      const hits = calendarNotes.filter((n) => studioNoteCoversDate(n, d.iso));
      if (hits.length) m.set(d.iso, hits);
    }
    return m;
  }, [calendarNotes, weekDays]);

  if (isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <SessionCardSkeleton />
        <SessionCardSkeleton />
        <SessionCardSkeleton />
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
        {hideWeekNavigation ? (
          <Text style={[styles.weekTitle, styles.weekTitleStatic]} numberOfLines={1}>
            {weekLabel}
          </Text>
        ) : (
          <>
            <Pressable
              onPress={() => bumpWeek(-1)}
              disabled={!canGoPrev}
              style={({ pressed }) => [
                styles.navBtn,
                !canGoPrev && styles.navBtnDisabled,
                pressed && canGoPrev && styles.navBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.a11yPrevWeek")}
              accessibilityState={{ disabled: !canGoPrev }}
            >
              <Text style={[styles.navChevron, !canGoPrev && styles.navChevronDisabled]}>{"←"}</Text>
            </Pressable>
            <Text style={styles.weekTitle} numberOfLines={1}>
              {weekLabel}
            </Text>
            <Pressable
              onPress={() => {
                if (!canGoNext) return;
                if (Platform.OS === "ios" || Platform.OS === "android") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                bumpWeek(1);
              }}
              disabled={!canGoNext}
              style={({ pressed }) => [
                styles.navBtn,
                !canGoNext && styles.navBtnDisabled,
                pressed && canGoNext && styles.navBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.a11yNextWeek")}
              accessibilityState={{ disabled: !canGoNext }}
            >
              <Text style={[styles.navChevron, !canGoNext && styles.navChevronDisabled]}>{"→"}</Text>
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.body}>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.scrollerContent, isRTL && styles.scrollerContentRtl]}
          style={styles.scroller}
        >
          {weekDays.map((d) => {
            const dayList = byDate.get(d.iso) ?? [];
            const isToday = d.iso === todayIso;
            const dayNotes = notesByDate.get(d.iso) ?? [];
            return (
              <View
                key={d.iso}
                style={[
                  styles.dayCol,
                  isToday && styles.dayColToday,
                ]}
              >
                <Pressable
                  onPress={() => onDayPress?.(d.iso)}
                  disabled={!onDayPress}
                  style={({ pressed }) => [
                    styles.dayHeaderBox,
                    pressed && onDayPress && styles.dayColPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    dayNotes.length
                      ? `${t("calendarNotes.dayHasNoteA11y")}: ${dayNotes.map((n) => n.title).join(", ")}. ` +
                        (isToday
                          ? language === "he"
                            ? `${dayNames[d.date.getDay()]} ${d.date.getDate()}, היום`
                            : `Today, ${dayNames[d.date.getDay()]} ${d.date.getDate()}`
                          : `${dayNames[d.date.getDay()]} ${d.date.getDate()}`)
                      : isToday
                        ? language === "he"
                          ? `${dayNames[d.date.getDay()]} ${d.date.getDate()}, היום`
                          : `Today, ${dayNames[d.date.getDay()]} ${d.date.getDate()}`
                        : `${dayNames[d.date.getDay()]} ${d.date.getDate()}`
                  }
                >
                  <Text style={styles.dayName}>{dayNames[d.date.getDay()]}</Text>
                  <Text style={[styles.dayNum, isToday && styles.dayNumToday]}>{d.date.getDate()}</Text>
                  <Text style={[styles.dayMonth, isToday && styles.dayMonthToday]}>
                    {d.date.toLocaleDateString(locale, { month: "short" })}
                  </Text>
                </Pressable>
                {dayNotes.length > 0 ? (
                  <View style={styles.dayNoteChips} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {dayNotes.map((n) => {
                      const acc = studioCalendarNoteAccent(n.kind);
                      return (
                        <View key={n.id} style={[styles.dayNoteChip, { borderColor: acc.border }]}>
                          <Text style={styles.dayNoteChipTxt} numberOfLines={3}>
                            {n.title.trim()}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                <View style={styles.dayItems}>
                  {dayList.map((it) => {
                    const phase = getSessionTemporalPhase(
                      it.session_date,
                      it.start_time,
                      it.durationMinutes ?? 60
                    );
                    const dimTemporal = it.hideTemporalDimming !== true;
                    const waitlistCta = typeof it.onJoinWaitlist === "function";
                    const waitlistJoinedStrip =
                      it.athleteOnWaitlist === true &&
                      waitlistCta === false &&
                      it.signedUpCount !== undefined &&
                      it.maxParticipants !== undefined &&
                      it.maxParticipants > 0 &&
                      (it.signedUpCount ?? 0) >= it.maxParticipants;
                    const isRegisteredCard =
                      it.athleteRegistered === true && phase !== "past" && phase !== "live";
                    if (waitlistCta || waitlistJoinedStrip) {
                      return (
                        <View
                          key={it.key}
                          style={[
                            styles.card,
                            isRegisteredCard && styles.cardRegistered,
                            dimTemporal && phase === "past" && styles.cardPast,
                            dimTemporal && phase === "live" && styles.cardLive,
                            dimTemporal && it.showStaffSessionLabels && it.isHidden ? { opacity: 0.55 } : null,
                          ]}
                        >
                          <Pressable
                            onPress={it.onPress}
                            disabled={!it.onPress}
                            style={({ pressed }) => [pressed && it.onPress && { opacity: 0.9 }]}
                          >
                            <SessionAgendaCardContent item={it} compact temporalPhase={phase} />
                          </Pressable>
                          {waitlistCta ? (
                            <AthleteWaitlistInviteStripe
                              compact
                              onPress={() => void Promise.resolve(it.onJoinWaitlist?.())}
                              joining={it.waitlistJoining}
                            />
                          ) : waitlistJoinedStrip ? (
                            <AthleteWaitlistJoinedStripe compact />
                          ) : null}
                        </View>
                      );
                    }

                    return (
                      <Pressable
                        key={it.key}
                        onPress={it.onPress}
                        disabled={!it.onPress}
                        style={({ pressed }) => [
                          styles.card,
                          isRegisteredCard && styles.cardRegistered,
                          dimTemporal && phase === "past" && styles.cardPast,
                          dimTemporal && phase === "live" && styles.cardLive,
                          dimTemporal && it.showStaffSessionLabels && it.isHidden ? { opacity: 0.55 } : null,
                          pressed && it.onPress && { opacity: 0.9 },
                        ]}
                      >
                        <SessionAgendaCardContent item={it} compact temporalPhase={phase} />
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </ScrollView>

        {weekItemsCount === 0 ? (
          <View style={styles.empty}>
            <EmptyState title={emptyLabel ?? t("empty.noSessionsWeek")} isRTL={isRTL} style={styles.emptyState} />
            <View style={styles.emptyActions}>
              <Pressable style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.9 }]} onPress={() => bumpWeek(-1)}>
                <Text style={styles.emptyBtnTxt}>{t("calendar.prevWeek")}</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.emptyBtn, pressed && { opacity: 0.9 }]} onPress={() => bumpWeek(1)}>
                <Text style={styles.emptyBtnTxt}>{t("calendar.nextWeek")}</Text>
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
  weekTitleStatic: {
    flex: 0,
    width: "100%",
  },
  navBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  navBtnPressed: { opacity: 0.88 },
  navBtnDisabled: { opacity: 0.35 },
  /** LTR glyphs so `<` / `>` are not bidi-mirrored inside Hebrew UI. */
  navChevron: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    writingDirection: "ltr",
  },
  navChevronDisabled: { color: theme.colors.textMuted },
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
    /** Slightly wider so session + waitlist CTA stay readable without ellipsis */
    width: 124,
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
  dayNoteChips: { alignSelf: "stretch", gap: 6, marginBottom: 8, width: "100%" },
  dayNoteChip: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    backgroundColor: theme.colors.backgroundAlt,
  },
  dayNoteChipTxt: {
    width: "100%",
    textAlign: "center",
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.text,
    lineHeight: 13,
  },
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
  cardPast: {
    opacity: 0.52,
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.border,
  },
  /** Booked session — white frame (distinct from green live and grey open). */
  cardRegistered: {
    borderWidth: 2,
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.surfaceElevated,
  },
  cardLive: {
    opacity: 1,
    borderWidth: 2,
    borderColor: theme.colors.success,
    backgroundColor: theme.colors.successBg,
  },
  empty: { paddingTop: theme.spacing.md, paddingBottom: theme.spacing.lg, alignItems: "center" },
  emptyState: { paddingVertical: theme.spacing.md, paddingHorizontal: theme.spacing.sm },
  emptyActions: { flexDirection: "row", writingDirection: "ltr", gap: 10, marginTop: 14 },
  emptyBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  emptyBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 13 },
  loadingWrap: { flex: 1, padding: theme.spacing.lg, gap: theme.spacing.sm },
});

