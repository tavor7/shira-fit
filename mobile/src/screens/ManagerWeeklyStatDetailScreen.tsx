import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Stack, useLocalSearchParams, router, type Href } from "expo-router";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import type { TrainingSessionWithTrainer } from "../types/database";
import { fetchActiveSignupCountsBySession } from "../lib/sessionSignupCounts";
import {
  formatISODateFull,
  formatISODateFullWithWeekdayAfter,
  formatDateTimeForDisplay,
} from "../lib/dateFormat";
import { formatSessionTimeRange, sessionStartsAt } from "../lib/sessionTime";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";

export type WeeklyDetailKind =
  | "avg_fill"
  | "cancellations"
  | "no_shows"
  | "sessions"
  | "waitlist"
  | "checked_in";

function parseKind(s: string | undefined): WeeklyDetailKind | null {
  const k = String(s ?? "").trim();
  const allowed: WeeklyDetailKind[] = [
    "avg_fill",
    "cancellations",
    "no_shows",
    "sessions",
    "waitlist",
    "checked_in",
  ];
  return allowed.includes(k as WeeklyDetailKind) ? (k as WeeklyDetailKind) : null;
}

function oneRelation<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function ManagerWeeklyStatDetailScreen() {
  const { language, isRTL, t } = useI18n();
  const params = useLocalSearchParams<{ weekStart?: string; weekEnd?: string; kind?: string }>();
  const weekStart = String(params.weekStart ?? "").trim();
  const weekEnd = String(params.weekEnd ?? "").trim();
  const kind = parseKind(params.kind);

  const title = useMemo(() => {
    if (!kind) return t("common.error");
    const map: Record<WeeklyDetailKind, string> = {
      avg_fill: t("dashboard.detailTitleAvgFill"),
      cancellations: t("dashboard.detailTitleCancellations"),
      no_shows: t("dashboard.detailTitleNoShows"),
      sessions: t("dashboard.detailTitleSessions"),
      waitlist: t("dashboard.detailTitleWaitlist"),
      checked_in: t("dashboard.detailTitleCheckedIn"),
    };
    return map[kind];
  }, [kind, t]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState<ReactNode>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (!weekStart || !weekEnd || !kind) {
        setError(language === "he" ? "פרמטרים חסרים או לא תקינים" : "Missing or invalid parameters");
        setBody(null);
        return;
      }

      const { data: weekRows, error: wErr } = await supabase
        .from("training_sessions")
        .select("id")
        .gte("session_date", weekStart)
        .lte("session_date", weekEnd);
      if (wErr) throw wErr;
      const sessionIds = ((weekRows ?? []) as { id: string }[]).map((r) => r.id);

      if (kind === "sessions" || kind === "avg_fill") {
        let res = await supabase
          .from("training_sessions")
          .select("*, trainer:profiles!coach_id(full_name, calendar_color)")
          .gte("session_date", weekStart)
          .lte("session_date", weekEnd)
          .order("session_date", { ascending: true })
          .order("start_time", { ascending: true });
        if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
          res = await supabase
            .from("training_sessions")
            .select("*, trainer:profiles!coach_id(full_name)")
            .gte("session_date", weekStart)
            .lte("session_date", weekEnd)
            .order("session_date", { ascending: true })
            .order("start_time", { ascending: true });
        }
        if (res.error) throw res.error;
        const sessions = (res.data ?? []) as TrainingSessionWithTrainer[];
        const ids = sessions.map((s) => s.id);
        const counts = await fetchActiveSignupCountsBySession(ids);
        const rows = sessions.map((s) => {
          const n = counts[s.id] ?? 0;
          const max = s.max_participants ?? 0;
          const pct = max > 0 ? Math.round(Math.min(1, n / max) * 1000) / 10 : 0;
          return { s, n, pct };
        });
        const ordered =
          kind === "avg_fill"
            ? [...rows].sort((a, b) => a.pct - b.pct || a.s.session_date.localeCompare(b.s.session_date))
            : rows;
        setBody(
          <View style={styles.list}>
            {ordered.map(({ s, n, pct }) => (
              <Pressable
                key={s.id}
                onPress={() => router.push(`/(app)/manager/session/${s.id}` as Href)}
                style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
                accessibilityRole="button"
                accessibilityLabel={language === "he" ? "פתיחת אימון" : "Open session"}
              >
                <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={2}>
                  {formatISODateFullWithWeekdayAfter(s.session_date, language)} ·{" "}
                  {formatSessionTimeRange(s.start_time, s.duration_minutes ?? 60)}
                </Text>
                <Text style={[styles.rowMeta, isRTL && styles.rtl]} numberOfLines={1}>
                  {s.trainer?.full_name ?? "—"}
                  {" · "}
                  {language === "he" ? "נרשמו" : "Signed up"} {n}/{s.max_participants || "—"}
                  {kind === "avg_fill" ? ` · ${pct}%` : ""}
                </Text>
                {s.is_hidden ? (
                  <Text style={styles.rowHint}>{language === "he" ? "מוסתר" : "Hidden"}</Text>
                ) : null}
              </Pressable>
            ))}
            {ordered.length === 0 ? (
              <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
            ) : null}
          </View>
        );
        return;
      }

      if (sessionIds.length === 0) {
        setBody(
          <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
        );
        return;
      }

      if (kind === "cancellations") {
        const { data, error: qErr } = await supabase
          .from("cancellations")
          .select(
            "cancelled_at, reason, charged_full_price, user_id, session_id, profiles(full_name), training_sessions(session_date, start_time, duration_minutes)"
          )
          .in("session_id", sessionIds)
          .order("cancelled_at", { ascending: false });
        if (qErr) throw qErr;
        const list = (data ?? []) as {
          cancelled_at: string;
          reason: string;
          charged_full_price: boolean | null;
          user_id: string;
          session_id: string;
          profiles: { full_name: string } | { full_name: string }[] | null;
          training_sessions:
            | { session_date: string; start_time: string; duration_minutes?: number | null }
            | { session_date: string; start_time: string; duration_minutes?: number | null }[]
            | null;
        }[];
        setBody(
          <View style={styles.list}>
            {list.map((c, idx) => {
              const p = c.profiles ? oneRelation(c.profiles) : null;
              const sess = oneRelation(c.training_sessions);
              const name = p?.full_name ?? c.user_id;
              return (
                <Pressable
                  key={`${c.session_id}-${c.user_id}-${c.cancelled_at}-${idx}`}
                  onPress={() => router.push(`/(app)/manager/session/${c.session_id}` as Href)}
                  style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={[styles.rowMeta, isRTL && styles.rtl]} numberOfLines={2}>
                    {sess
                      ? `${formatISODateFullWithWeekdayAfter(sess.session_date, language)} · ${formatSessionTimeRange(sess.start_time, sess.duration_minutes ?? 60)}`
                      : "—"}
                  </Text>
                  <Text style={[styles.rowDetail, isRTL && styles.rtl]} numberOfLines={3}>
                    {language === "he" ? "סיבה: " : "Reason: "}
                    {c.reason}
                  </Text>
                  <Text style={styles.rowHint}>
                    {formatDateTimeForDisplay(c.cancelled_at, language)}
                    {c.charged_full_price ? ` · ${language === "he" ? "חיוב מלא" : "Full charge"}` : ""}
                  </Text>
                </Pressable>
              );
            })}
            {list.length === 0 ? (
              <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
            ) : null}
          </View>
        );
        return;
      }

      if (kind === "no_shows") {
        const { data, error: qErr } = await supabase
          .from("session_registrations")
          .select(
            "user_id, session_id, profiles(full_name), training_sessions(session_date, start_time, duration_minutes)"
          )
          .eq("status", "active")
          .eq("attended", false)
          .in("session_id", sessionIds);
        if (qErr) throw qErr;
        const now = Date.now();
        const raw = (data ?? []) as unknown as {
          user_id: string;
          session_id: string;
          profiles: { full_name: string } | { full_name: string }[] | null;
          training_sessions:
            | {
                session_date: string;
                start_time: string;
                duration_minutes?: number | null;
              }
            | {
                session_date: string;
                start_time: string;
                duration_minutes?: number | null;
              }[]
            | null;
        }[];
        const list = raw.filter((r) => {
          const sess = oneRelation(r.training_sessions as any);
          if (!sess?.session_date || !sess.start_time) return false;
          return sessionStartsAt(sess.session_date, sess.start_time).getTime() < now;
        });
        list.sort((a, b) => {
          const sa = oneRelation(a.training_sessions as any);
          const sb = oneRelation(b.training_sessions as any);
          const ka = `${sa?.session_date ?? ""} ${sa?.start_time ?? ""}`;
          const kb = `${sb?.session_date ?? ""} ${sb?.start_time ?? ""}`;
          return ka.localeCompare(kb);
        });
        setBody(
          <View style={styles.list}>
            {list.map((r) => {
              const p = r.profiles ? oneRelation(r.profiles) : null;
              const sess = oneRelation(r.training_sessions as any);
              const name = p?.full_name ?? r.user_id;
              return (
                <Pressable
                  key={`${r.session_id}-${r.user_id}`}
                  onPress={() => router.push(`/(app)/manager/session/${r.session_id}` as Href)}
                  style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
                >
                  <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={[styles.rowMeta, isRTL && styles.rtl]} numberOfLines={2}>
                    {sess
                      ? `${formatISODateFullWithWeekdayAfter(sess.session_date, language)} · ${formatSessionTimeRange(sess.start_time, sess.duration_minutes ?? 60)}`
                      : "—"}
                  </Text>
                </Pressable>
              );
            })}
            {list.length === 0 ? (
              <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
            ) : null}
          </View>
        );
        return;
      }

      if (kind === "waitlist") {
        const { data, error: qErr } = await supabase
          .from("waitlist_requests")
          .select("requested_at, user_id, session_id, profiles(full_name), training_sessions(session_date, start_time)")
          .in("session_id", sessionIds)
          .order("requested_at", { ascending: false });
        if (qErr) throw qErr;
        const list = (data ?? []) as unknown as {
          requested_at: string;
          user_id: string;
          session_id: string;
          profiles: { full_name: string } | { full_name: string }[] | null;
          training_sessions:
            | { session_date: string; start_time: string }
            | { session_date: string; start_time: string }[]
            | null;
        }[];
        setBody(
          <View style={styles.list}>
            {list.map((w) => {
              const p = w.profiles ? oneRelation(w.profiles) : null;
              const sess = oneRelation(w.training_sessions as any);
              const name = p?.full_name ?? w.user_id;
              return (
                <Pressable
                  key={`${w.session_id}-${w.user_id}-${w.requested_at}`}
                  onPress={() => router.push(`/(app)/manager/session/${w.session_id}` as Href)}
                  style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
                >
                  <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={[styles.rowMeta, isRTL && styles.rtl]} numberOfLines={2}>
                    {sess
                      ? `${formatISODateFullWithWeekdayAfter(sess.session_date, language)} · ${formatSessionTimeRange(sess.start_time, 60)}`
                      : "—"}
                  </Text>
                  <Text style={styles.rowHint}>{formatDateTimeForDisplay(w.requested_at, language)}</Text>
                </Pressable>
              );
            })}
            {list.length === 0 ? (
              <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
            ) : null}
          </View>
        );
        return;
      }

      if (kind === "checked_in") {
        const [regRes, manRes] = await Promise.all([
          supabase
            .from("session_registrations")
            .select("user_id, session_id, profiles(full_name), training_sessions(session_date, start_time, duration_minutes)")
            .eq("status", "active")
            .eq("attended", true)
            .in("session_id", sessionIds),
          supabase
            .from("session_manual_participants")
            .select("session_id, manual_participants(full_name), training_sessions(session_date, start_time, duration_minutes)")
            .eq("attended", true)
            .in("session_id", sessionIds),
        ]);
        if (regRes.error) throw regRes.error;
        if (manRes.error) throw manRes.error;
        type Row = {
          name: string;
          session_id: string;
          session_date: string;
          start_time: string;
          duration_minutes: number;
        };
        const rows: Row[] = [];
        for (const r of (regRes.data ?? []) as any[]) {
          const pr = r.profiles ? oneRelation(r.profiles) : null;
          const sess = oneRelation(r.training_sessions);
          if (!sess?.session_date) continue;
          rows.push({
            name: pr?.full_name ?? r.user_id,
            session_id: r.session_id,
            session_date: sess.session_date,
            start_time: sess.start_time,
            duration_minutes: sess.duration_minutes ?? 60,
          });
        }
        for (const r of (manRes.data ?? []) as any[]) {
          const mp = r.manual_participants ? oneRelation(r.manual_participants) : null;
          const sess = oneRelation(r.training_sessions);
          if (!sess?.session_date) continue;
          rows.push({
            name: mp?.full_name ?? (language === "he" ? "משתתף ידני" : "Manual participant"),
            session_id: r.session_id,
            session_date: sess.session_date,
            start_time: sess.start_time,
            duration_minutes: sess.duration_minutes ?? 60,
          });
        }
        rows.sort((a, b) =>
          `${a.session_date} ${a.start_time}`.localeCompare(`${b.session_date} ${b.start_time}`)
        );
        setBody(
          <View style={styles.list}>
            {rows.map((r, idx) => (
              <Pressable
                key={`${r.session_id}-${r.name}-${idx}`}
                onPress={() => router.push(`/(app)/manager/session/${r.session_id}` as Href)}
                style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
              >
                <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={2}>
                  {r.name}
                </Text>
                <Text style={[styles.rowMeta, isRTL && styles.rtl]} numberOfLines={2}>
                  {formatISODateFullWithWeekdayAfter(r.session_date, language)} ·{" "}
                  {formatSessionTimeRange(r.start_time, r.duration_minutes)}
                </Text>
              </Pressable>
            ))}
            {rows.length === 0 ? (
              <Text style={[styles.empty, isRTL && styles.rtl]}>{t("dashboard.detailEmpty")}</Text>
            ) : null}
          </View>
        );
        return;
      }

      setBody(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBody(null);
    } finally {
      setLoading(false);
    }
  }, [weekStart, weekEnd, kind, language, isRTL, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rangeLabel = useMemo(() => {
    if (!weekStart || !weekEnd) return "";
    try {
      return `${formatISODateFull(weekStart, language)} → ${formatISODateFull(weekEnd, language)}`;
    } catch {
      return "";
    }
  }, [weekStart, weekEnd, language]);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <ManagerOverviewTabs />
        {rangeLabel ? (
          <Text style={[styles.range, isRTL && styles.rtl]}>{rangeLabel}</Text>
        ) : null}
        {kind === "avg_fill" ? (
          <Text style={[styles.hint, isRTL && styles.rtl]}>{t("dashboard.detailHintAvgFill")}</Text>
        ) : null}

        {loading ? <ActivityIndicator color={theme.colors.cta} style={{ marginTop: 16 }} /> : null}
        {error ? <Text style={styles.err}>{error}</Text> : null}
        {!loading && !error ? body : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: 40 },
  range: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
    marginBottom: 8,
  },
  hint: { fontSize: 13, color: theme.colors.textSoft, marginBottom: 12, lineHeight: 18 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  err: { color: theme.colors.error, fontWeight: "700", marginTop: 12 },
  list: { gap: 10, marginTop: 8 },
  rowCard: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowCardPressed: { opacity: Platform.OS === "web" ? 0.92 : 0.88 },
  rowTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  rowMeta: { marginTop: 6, fontSize: 14, fontWeight: "600", color: theme.colors.textMuted },
  rowDetail: { marginTop: 8, fontSize: 14, color: theme.colors.text, lineHeight: 20 },
  rowHint: { marginTop: 6, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  empty: { marginTop: 12, color: theme.colors.textSoft, fontWeight: "600" },
});
