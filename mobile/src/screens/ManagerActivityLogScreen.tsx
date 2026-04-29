import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";
import { DatePickerField } from "../components/DatePickerField";
import { PrimaryButton } from "../components/PrimaryButton";
import { parseISODateLocal, toISODateLocal } from "../lib/isoDate";

type Row = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
};

type SessionRow = {
  id: string;
  session_date: string;
  start_time: string;
  max_participants: number;
  duration_minutes: number;
  coach_id: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatWhen(iso: string, language: string) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(language === "he" ? "he-IL" : "en-GB", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

type DatePreset = "7" | "14" | "30" | "90" | "all" | "custom";

type ActivityGroupId = "all" | "auth" | "profiles" | "sessions" | "registration";

const ACTIVITY_GROUP_TYPES: Record<Exclude<ActivityGroupId, "all">, string[]> = {
  auth: ["auth_login", "email_confirmed", "password_reset_completed", "signup_completed"],
  profiles: [
    "athlete_profile_created",
    "profile_created",
    "profile_updated",
    "athlete_approved",
    "athlete_rejected",
    "athlete_approval_updated",
  ],
  sessions: ["session_created", "session_updated", "session_deleted"],
  registration: ["session_registration", "session_registration_cancelled", "session_registration_status_changed"],
};

function eventTypesForActivityGroup(g: ActivityGroupId): string[] | null {
  if (g === "all") return null;
  return ACTIVITY_GROUP_TYPES[g];
}

const RETENTION_CHIPS = [7, 14, 30, 60, 90, 180, 365] as const;

const PAGE_SIZE = 25;

function isoBoundsFromLocalDates(dateFrom: string, dateTo: string): { startIso: string; endIso: string } | null {
  let df = parseISODateLocal(dateFrom);
  let dt = parseISODateLocal(dateTo);
  if (!df || !dt) return null;
  if (df.getTime() > dt.getTime()) {
    const s = df;
    df = dt;
    dt = s;
  }
  const start = new Date(df.getFullYear(), df.getMonth(), df.getDate(), 0, 0, 0, 0);
  const end = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function computePresetRange(preset: DatePreset, retentionDays: number): { from: string; to: string } {
  const now = new Date();
  const to = toISODateLocal(now);
  const toD = parseISODateLocal(to);
  if (!toD) return { from: to, to };
  let daysBack: number;
  switch (preset) {
    case "7":
      daysBack = 7;
      break;
    case "14":
      daysBack = 14;
      break;
    case "30":
      daysBack = 30;
      break;
    case "90":
      daysBack = 90;
      break;
    case "all":
      daysBack = Math.max(1, retentionDays);
      break;
    default:
      daysBack = 14;
  }
  const fromD = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() - (daysBack - 1));
  return { from: toISODateLocal(fromD), to };
}

function ChipButton({
  label,
  active,
  onPress,
  compact,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        compact && styles.chipCompact,
        active && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipLabel, compact && styles.chipLabelCompact, active && styles.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function isFromTo(val: unknown): val is { from: unknown; to: unknown } {
  return typeof val === "object" && val !== null && "from" in val && "to" in val;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

async function fetchProfileLabels(userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out: Record<string, string> = {};
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase.from("profiles").select("user_id, full_name, username").in("user_id", chunk);
    for (const p of data ?? []) {
      const row = p as { user_id: string; full_name: string | null; username: string | null };
      const fn = (row.full_name ?? "").trim();
      const un = (row.username ?? "").trim();
      out[row.user_id] = fn ? (un ? `${fn} (@${un})` : fn) : un ? `@${un}` : `${row.user_id.slice(0, 8)}…`;
    }
  }
  return out;
}

async function fetchSessionsRaw(ids: string[]): Promise<SessionRow[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: SessionRow[] = [];
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase
      .from("training_sessions")
      .select("id, session_date, start_time, max_participants, duration_minutes, coach_id")
      .in("id", chunk);
    for (const s of data ?? []) out.push(s as SessionRow);
  }
  return out;
}

function sessionOneLine(s: SessionRow, _language: string): string {
  const time = String(s.start_time ?? "").slice(0, 5);
  return `${s.session_date} · ${time} · max ${s.max_participants} · ${s.duration_minutes} min`;
}

function collectIdsFromRow(row: Row, profileIds: Set<string>, sessionIds: Set<string>) {
  if (row.actor_user_id) profileIds.add(row.actor_user_id);
  if (row.target_type === "profile" && row.target_id) profileIds.add(row.target_id);
  if (row.target_type === "training_session" && row.target_id) sessionIds.add(row.target_id);

  const m = row.metadata;
  if (!m || typeof m !== "object") return;
  const mu = m as Record<string, unknown>;

  if (typeof mu.target_user_id === "string") profileIds.add(mu.target_user_id);
  if (typeof mu.edited_user_id === "string") profileIds.add(mu.edited_user_id);
  if (typeof mu.user_id === "string") profileIds.add(mu.user_id);
  if (typeof mu.session_id === "string") sessionIds.add(mu.session_id);
  if (typeof mu.coach_id === "string" && UUID_RE.test(mu.coach_id)) profileIds.add(mu.coach_id);

  for (const snapKey of ["after", "before"] as const) {
    const snap = mu[snapKey];
    if (snap && typeof snap === "object") {
      const c = (snap as Record<string, unknown>).coach_id;
      if (typeof c === "string" && UUID_RE.test(c)) profileIds.add(c);
    }
  }

  const ch = mu.changes;
  if (ch && typeof ch === "object") {
    for (const v of Object.values(ch as Record<string, unknown>)) {
      if (isFromTo(v)) {
        if (typeof v.from === "string" && UUID_RE.test(v.from)) profileIds.add(v.from);
        if (typeof v.to === "string" && UUID_RE.test(v.to)) profileIds.add(v.to);
      }
    }
  }
}

function sessionFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    session_date: { en: "Date", he: "\u05ea\u05d0\u05e8\u05d9\u05da" },
    start_time: { en: "Start time", he: "\u05e9\u05e2\u05ea \u05d4\u05ea\u05d7\u05dc\u05d4" },
    coach_id: { en: "Coach", he: "\u05de\u05d0\u05de\u05df" },
    max_participants: { en: "Max participants", he: "\u05de\u05e7\u05e1\u05d9\u05de\u05d5\u05dd \u05de\u05e9\u05ea\u05ea\u05e4\u05d9\u05dd" },
    is_open_for_registration: { en: "Open for registration", he: "\u05e4\u05ea\u05d5\u05d7 \u05dc\u05d4\u05e8\u05e9\u05de\u05d4" },
    duration_minutes: { en: "Duration (min)", he: "\u05de\u05e9\u05da (\u05d3\u05e7\u05d5\u05ea)" },
    is_hidden: { en: "Hidden", he: "\u05de\u05d5\u05e1\u05ea\u05e8" },
  };
  const m = map[key];
  return m ? (he ? m.he : m.en) : key;
}

function profileFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    full_name: { en: "Full name", he: "שם מלא" },
    phone: { en: "Phone", he: "טלפון" },
    gender: { en: "Gender", he: "מין" },
    date_of_birth: { en: "Date of birth", he: "\u05ea\u05d0\u05e8\u05d9\u05da \u05dc\u05d9\u05d3\u05d4" },
    username: { en: "Username", he: "שם משתמש" },
  };
  const m = map[key];
  return m ? (he ? m.he : m.en) : key;
}

function formatCoachRef(id: string, profileLabels: Record<string, string>): string {
  return profileLabels[id] ?? `${id.slice(0, 8)}…`;
}

function buildDetailLines(
  item: Row,
  profileLabels: Record<string, string>,
  sessionSummaries: Record<string, string>,
  language: string
): string[] {
  const lines: string[] = [];
  const he = language === "he";
  const L = (en: string, h: string) => (he ? h : en);
  const m = item.metadata || {};
  const mu = m as Record<string, unknown>;

  if (["athlete_approved", "athlete_rejected", "athlete_approval_updated"].includes(item.event_type)) {
    const tid = (typeof mu.target_user_id === "string" ? mu.target_user_id : null) ?? item.target_id;
    const fn = typeof mu.target_full_name === "string" ? mu.target_full_name.trim() : "";
    const un = typeof mu.target_username === "string" ? mu.target_username.trim() : "";
    const fromMeta =
      fn && un ? `${fn} (@${un})` : fn ? fn : un ? `@${un}` : tid ? profileLabels[tid] ?? `${tid.slice(0, 8)}…` : "—";
    lines.push(`${L("Athlete / user", "מתאמן / משתמש")}: ${fromMeta}`);
    if (mu.previous_approval_status != null && mu.new_approval_status != null) {
      lines.push(
        `${L("Approval", "אישור")}: ${str(mu.previous_approval_status)} → ${str(mu.new_approval_status)}`
      );
    } else if (mu.previous_approval_status != null && mu.status != null) {
      lines.push(`${L("Approval", "אישור")}: ${str(mu.previous_approval_status)} → ${str(mu.status)}`);
    } else if (mu.new_approval_status != null) {
      lines.push(`${L("New approval status", "סטטוס אישור חדש")}: ${str(mu.new_approval_status)}`);
    } else if (mu.status != null) {
      lines.push(`${L("New status", "סטטוס חדש")}: ${str(mu.status)}`);
    }
    return lines;
  }

  if (item.event_type === "profile_updated") {
    const edited =
      (typeof mu.edited_user_id === "string" ? mu.edited_user_id : null) ?? item.target_id ?? null;
    if (edited) {
      lines.push(`${L("Edited profile", "פרופיל שעודכן")}: ${profileLabels[edited] ?? `${edited.slice(0, 8)}…`}`);
    }
    const changes = mu.changes;
    if (changes && typeof changes === "object") {
      for (const [key, val] of Object.entries(changes as Record<string, unknown>)) {
        if (isFromTo(val)) {
          lines.push(`${profileFieldLabel(key, he)}: ${str(val.from)} → ${str(val.to)}`);
        }
      }
    }
    const legacy = ["full_name", "phone", "gender", "date_of_birth", "username"].filter((k) => mu[k] === true);
    if (legacy.length && (!changes || typeof changes !== "object" || Object.keys(changes as object).length === 0)) {
      lines.push(
        `${L("Fields touched (older log — values not stored)", "שדות שעודכנו (רישום ישן — ללא ערכים)")}: ${legacy.join(", ")}`
      );
    }
    return lines;
  }

  if (item.event_type === "session_created" && mu.after && typeof mu.after === "object") {
    const snap = mu.after as Record<string, unknown>;
    const sid = item.target_id;
    if (sid && sessionSummaries[sid]) lines.push(`${L("Session", "אימון")}: ${sessionSummaries[sid]}`);
    lines.push(
      `${L("Date", "\u05ea\u05d0\u05e8\u05d9\u05da")}: ${str(snap.session_date)} · ${L("Time", "\u05e9\u05e2\u05d4")}: ${str(snap.start_time).slice(0, 5)}`
    );
    lines.push(
      `${L("Max", "\u05de\u05e7\u05e1\u05d9\u05de\u05d5\u05dd")}: ${str(snap.max_participants)} · ${L("Duration", "\u05de\u05e9\u05da")}: ${str(snap.duration_minutes)} min`
    );
    const cid = snap.coach_id;
    if (typeof cid === "string") lines.push(`${L("Coach", "מאמן")}: ${formatCoachRef(cid, profileLabels)}`);
    lines.push(`${L("Open for registration", "פתוח להרשמה")}: ${str(snap.is_open_for_registration)} · ${L("Hidden", "מוסתר")}: ${str(snap.is_hidden)}`);
    return lines;
  }

  if (item.event_type === "session_deleted" && mu.before && typeof mu.before === "object") {
    const snap = mu.before as Record<string, unknown>;
    const sid = item.target_id;
    if (sid && sessionSummaries[sid]) lines.push(`${L("Session", "אימון")}: ${sessionSummaries[sid]}`);
    lines.push(
      `${L("Was", "\u05d4\u05d9\u05d4")}: ${str(snap.session_date)} · ${str(snap.start_time).slice(0, 5)} · ${L("max", "\u05de\u05e7\u05e1")} ${str(snap.max_participants)}`
    );
    const cid = snap.coach_id;
    if (typeof cid === "string") lines.push(`${L("Coach", "מאמן")}: ${formatCoachRef(cid, profileLabels)}`);
    return lines;
  }

  if (item.event_type === "session_updated" && mu.changes && typeof mu.changes === "object") {
    const sid = item.target_id;
    if (sid && sessionSummaries[sid]) lines.push(`${L("Session", "אימון")}: ${sessionSummaries[sid]}`);
    for (const [key, val] of Object.entries(mu.changes as Record<string, unknown>)) {
      if (!isFromTo(val)) continue;
      if (key === "coach_id") {
        lines.push(
          `${sessionFieldLabel(key, he)}: ${formatCoachRef(str(val.from), profileLabels)} → ${formatCoachRef(str(val.to), profileLabels)}`
        );
      } else {
        lines.push(`${sessionFieldLabel(key, he)}: ${str(val.from)} → ${str(val.to)}`);
      }
    }
    return lines;
  }

  if (
    item.event_type === "session_registration" ||
    item.event_type === "session_registration_cancelled" ||
    item.event_type === "session_registration_status_changed"
  ) {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const pid = typeof mu.user_id === "string" ? mu.user_id : null;
    if (sid) lines.push(`${L("Session", "אימון")}: ${sessionSummaries[sid] ?? `${sid.slice(0, 8)}…`}`);
    if (pid) lines.push(`${L("Participant", "משתתף")}: ${profileLabels[pid] ?? `${pid.slice(0, 8)}…`}`);
    if (mu.status != null) lines.push(`${L("Registration status", "סטטוס הרשמה")}: ${str(mu.status)}`);
    if (mu.from != null && mu.to != null) {
      lines.push(`${L("Status change", "שינוי סטטוס")}: ${str(mu.from)} → ${str(mu.to)}`);
    }
    return lines;
  }

  if (item.event_type === "athlete_profile_created" || item.event_type === "profile_created") {
    const tid = item.target_id;
    if (tid) lines.push(`${L("Profile", "פרופיל")}: ${profileLabels[tid] ?? `${tid.slice(0, 8)}…`}`);
    if (mu.role != null) lines.push(`${L("Role", "תפקיד")}: ${str(mu.role)}`);
    if (mu.approval_status != null) lines.push(`${L("Approval status", "סטטוס אישור")}: ${str(mu.approval_status)}`);
    return lines;
  }

  if (["auth_login", "email_confirmed", "password_reset_completed", "signup_completed"].includes(item.event_type)) {
    lines.push(
      L(
        "This event is tied to the actor account only.",
        "\u05d0\u05d9\u05e8\u05d5\u05e2 \u05d6\u05d4 \u05de\u05e9\u05d5\u05d9\u05da \u05dc\u05d7\u05e9\u05d1\u05d5\u05df \u05d4\u05de\u05d1\u05e6\u05e2 \u05d1\u05dc\u05d1\u05d3."
      )
    );
    return lines;
  }

  return lines;
}

function eventLabel(eventType: string, language: string): string {
  const map: Record<string, { en: string; he: string }> = {
    auth_login: { en: "Login", he: "התחברות" },
    email_confirmed: { en: "Email confirmed", he: "אימייל אומת" },
    password_reset_completed: { en: "Password reset completed", he: "איפוס סיסמה הושלם" },
    signup_completed: { en: "Signup completed", he: "הרשמה הושלמה" },
    athlete_profile_created: { en: "Athlete profile created", he: "פרופיל מתאמן נוצר" },
    profile_created: { en: "Profile created", he: "פרופיל נוצר" },
    profile_updated: { en: "Profile updated", he: "פרופיל עודכן" },
    athlete_approved: { en: "Athlete approved", he: "מתאמן אושר" },
    athlete_rejected: { en: "Athlete rejected", he: "מתאמן נדחה" },
    athlete_approval_updated: { en: "Athlete approval updated", he: "סטטוס אישור עודכן" },
    session_created: { en: "Session created", he: "אימון נוצר" },
    session_updated: { en: "Session updated", he: "אימון עודכן" },
    session_deleted: { en: "Session deleted", he: "אימון נמחק" },
    session_registration: { en: "Session registration", he: "הרשמה לאימון" },
    session_registration_cancelled: { en: "Registration cancelled", he: "הרשמה בוטלה" },
    session_registration_status_changed: { en: "Registration status changed", he: "סטטוס הרשמה השתנה" },
  };
  const m = map[eventType];
  if (!m) return eventType;
  return language === "he" ? m.he : m.en;
}

export default function ManagerActivityLogScreen() {
  const { language, isRTL, t } = useI18n();
  const initRange = computePresetRange("14", 14);
  const [dateFrom, setDateFrom] = useState(initRange.from);
  const [dateTo, setDateTo] = useState(initRange.to);
  const [datePreset, setDatePreset] = useState<DatePreset>("14");
  const [retentionDays, setRetentionDays] = useState(14);
  const [retentionDraft, setRetentionDraft] = useState(14);
  const [savingRetention, setSavingRetention] = useState(false);
  const [activityGroup, setActivityGroup] = useState<ActivityGroupId>("all");
  const [retentionExpanded, setRetentionExpanded] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [profileLabels, setProfileLabels] = useState<Record<string, string>>({});
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  const reload = useCallback(
    async (forcePage?: number) => {
      const bounds = isoBoundsFromLocalDates(dateFrom, dateTo);
      if (!bounds) {
        setRows([]);
        setProfileLabels({});
        setSessionSummaries({});
        setTotalCount(0);
        setLoading(false);
        return;
      }

      const effectivePage = forcePage !== undefined ? forcePage : pageIndex;

      setLoading(true);
      try {
        await supabase.rpc("manager_prune_activity_logs");
        const { data: retRaw } = await supabase.rpc("get_activity_log_retention_days");
        const ret = Math.min(730, Math.max(1, Number(retRaw) || 14));
        setRetentionDays(ret);

        const typeFilter = eventTypesForActivityGroup(activityGroup);
        const rangeFrom = effectivePage * PAGE_SIZE;
        const rangeTo = rangeFrom + PAGE_SIZE - 1;

        let evQuery = supabase
          .from("user_activity_events")
          .select("id, created_at, actor_user_id, event_type, target_type, target_id, metadata", {
            count: "exact",
          })
          .gte("created_at", bounds.startIso)
          .lte("created_at", bounds.endIso);
        if (typeFilter) evQuery = evQuery.in("event_type", typeFilter);
        const { data, error, count } = await evQuery
          .order("created_at", { ascending: false })
          .range(rangeFrom, rangeTo);

        const total = typeof count === "number" ? count : 0;
        setTotalCount(total);

        const maxPageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        if (total > 0 && effectivePage > maxPageIndex) {
          setPageIndex(maxPageIndex);
          return;
        }
        if (total === 0 && effectivePage > 0) {
          setPageIndex(0);
          return;
        }

        if (forcePage !== undefined && forcePage !== pageIndex) {
          setPageIndex(forcePage);
        }

        const list = !error && data ? (data as Row[]) : [];
        setRows(list);

        const profileIds = new Set<string>();
        const sessionIds = new Set<string>();
        for (const r of list) collectIdsFromRow(r, profileIds, sessionIds);

        const sessions = await fetchSessionsRaw([...sessionIds]);
        const sum: Record<string, string> = {};
        for (const s of sessions) {
          sum[s.id] = sessionOneLine(s, language);
          profileIds.add(s.coach_id);
        }
        setSessionSummaries(sum);

        const labels = await fetchProfileLabels([...profileIds]);
        setProfileLabels(labels);
      } finally {
        setLoading(false);
      }
    },
    [activityGroup, dateFrom, dateTo, language, pageIndex]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }

  function onPickDatePreset(p: DatePreset) {
    setPageIndex(0);
    setDatePreset(p);
    if (p !== "custom") {
      const r = computePresetRange(p, retentionDays);
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  }

  async function saveRetention() {
    setSavingRetention(true);
    try {
      const { data, error } = await supabase.rpc("set_activity_log_retention_days", { p_days: retentionDraft });
      if (error) throw error;
      const parsed = data as { ok?: boolean; deleted?: number; retention_days?: number };
      if (parsed && parsed.ok === false) {
        Alert.alert(t("common.error"), t("activityLog.purgeFailed"));
        return;
      }
      const d = parsed?.retention_days ?? retentionDraft;
      const n = parsed?.deleted ?? 0;
      setRetentionDays(d);
      setRetentionDraft(d);
      const msg = t("activityLog.purgeDone").replace(/\{d\}/g, String(d)).replace(/\{n\}/g, String(n));
      Alert.alert(t("common.saved"), msg);
      if (datePreset === "all") {
        const r = computePresetRange("all", d);
        setDateFrom(r.from);
        setDateTo(r.to);
      }
      await reload(0);
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof Error ? e.message : t("activityLog.purgeFailed"));
    } finally {
      setSavingRetention(false);
    }
  }

  const datePresetRows: { preset: DatePreset; labelKey: string }[] = [
    { preset: "7", labelKey: "activityLog.preset7" },
    { preset: "14", labelKey: "activityLog.preset14" },
    { preset: "30", labelKey: "activityLog.preset30" },
    { preset: "90", labelKey: "activityLog.preset90" },
    { preset: "all", labelKey: "activityLog.presetAll" },
    { preset: "custom", labelKey: "activityLog.presetCustom" },
  ];

  const activityGroupRows: { id: ActivityGroupId; labelKey: string }[] = [
    { id: "all", labelKey: "activityLog.typeAll" },
    { id: "auth", labelKey: "activityLog.typeAuth" },
    { id: "profiles", labelKey: "activityLog.typeProfiles" },
    { id: "sessions", labelKey: "activityLog.typeSessions" },
    { id: "registration", labelKey: "activityLog.typeRegistrations" },
  ];

  const filtersSection = (
    <View style={styles.headerBlock}>
      <View style={styles.filterCard}>
        <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>{t("activityLog.filterTitle")}</Text>
        <View style={styles.chipWrap}>
          {datePresetRows.map(({ preset, labelKey }) => (
            <ChipButton
              key={preset}
              label={t(labelKey)}
              active={datePreset === preset}
              onPress={() => onPickDatePreset(preset)}
              compact
            />
          ))}
        </View>
        {datePreset === "custom" ? (
          <View style={styles.customDates}>
            <View style={styles.dateField}>
              <DatePickerField
                label={t("common.from")}
                value={dateFrom}
              onChange={(v) => {
                setPageIndex(0);
                setDateFrom(v);
                setDatePreset("custom");
              }}
                maximumDate={parseISODateLocal(dateTo) ?? undefined}
              />
            </View>
            <View style={styles.dateField}>
              <DatePickerField
                label={t("common.to")}
                value={dateTo}
              onChange={(v) => {
                setPageIndex(0);
                setDateTo(v);
                setDatePreset("custom");
              }}
                minimumDate={parseISODateLocal(dateFrom) ?? undefined}
              />
            </View>
          </View>
        ) : null}

        <Text style={[styles.sectionLabel, styles.sectionLabelSpaced, isRTL && styles.rtl]}>
          {t("activityLog.activityType")}
        </Text>
        <View style={styles.chipWrap}>
          {activityGroupRows.map(({ id, labelKey }) => (
            <ChipButton
              key={id}
              label={t(labelKey)}
              active={activityGroup === id}
              onPress={() => {
                setPageIndex(0);
                setActivityGroup(id);
              }}
              compact
            />
          ))}
        </View>
      </View>

      <View style={styles.retentionShell}>
        <Pressable
          onPress={() => setRetentionExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: retentionExpanded }}
          accessibilityLabel={t("a11y.activityLogToggleRetention")}
          style={({ pressed }) => [
            styles.retentionHeader,
            isRTL && styles.retentionHeaderRtl,
            pressed && styles.retentionHeaderPressed,
          ]}
        >
          <View style={[styles.retentionHeaderMain, isRTL && styles.retentionHeaderMainRtl]}>
            <Text style={[styles.retentionHeaderTitle, isRTL && styles.rtl]}>{t("activityLog.retentionTitle")}</Text>
            <Text style={[styles.retentionHeaderSummary, isRTL && styles.rtl]}>
              {t("activityLog.currentRetention").replace(/\{d\}/g, String(retentionDays))}
            </Text>
            {!retentionExpanded ? (
              <Text style={[styles.retentionHeaderHint, isRTL && styles.rtl]}>{t("activityLog.retentionTapToExpand")}</Text>
            ) : null}
          </View>
          <Text style={styles.retentionChevron}>
            {retentionExpanded ? "\u25bc" : isRTL ? "\u25c0" : "\u25b6"}
          </Text>
        </Pressable>

        {retentionExpanded ? (
          <View style={styles.retentionBody}>
            <Text style={[styles.retentionCaption, isRTL && styles.rtl]}>{t("activityLog.retentionHint")}</Text>
            <View style={styles.chipWrap}>
              {RETENTION_CHIPS.map((d) => (
                <ChipButton key={d} label={`${d}`} active={retentionDraft === d} onPress={() => setRetentionDraft(d)} compact />
              ))}
            </View>
            <PrimaryButton
              label={t("activityLog.savePurge")}
              loadingLabel={t("activityLog.saving")}
              loading={savingRetention}
              onPress={saveRetention}
              style={styles.retentionSaveBtn}
            />
          </View>
        ) : null}
      </View>
    </View>
  );

  const listHeader = (
    <View style={styles.listHeaderPad}>
      <ManagerOverviewTabs />
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.activityLog")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>{t("activityLog.hint")}</Text>
      {filtersSection}
    </View>
  );

  const maxPageIndex =
    totalCount !== null && totalCount > 0 ? Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1) : 0;
  const rowFrom = totalCount && totalCount > 0 ? pageIndex * PAGE_SIZE + 1 : 0;
  const rowTo = totalCount && totalCount > 0 ? Math.min((pageIndex + 1) * PAGE_SIZE, totalCount) : 0;
  const pageSummaryText = t("activityLog.pageSummary")
    .replace(/\{from\}/g, String(rowFrom))
    .replace(/\{to\}/g, String(rowTo))
    .replace(/\{total\}/g, String(totalCount ?? 0));

  const listFooter = (
    <View style={styles.listFooterWrap}>
      {loading && rows.length > 0 ? (
        <ActivityIndicator style={{ marginVertical: 12 }} color={theme.colors.cta} />
      ) : null}
      {totalCount !== null && totalCount > 0 ? (
        <View style={[styles.paginationBar, isRTL && styles.paginationBarRtl]}>
          <Pressable
            disabled={loading || pageIndex <= 0}
            onPress={() => setPageIndex((p) => Math.max(0, p - 1))}
            style={({ pressed }) => [
              styles.paginationBtn,
              (loading || pageIndex <= 0) && styles.paginationBtnDisabled,
              pressed && !(loading || pageIndex <= 0) && styles.paginationBtnPressed,
            ]}
          >
            <Text
              style={[
                styles.paginationBtnText,
                (loading || pageIndex <= 0) && styles.paginationBtnTextDisabled,
                isRTL && styles.rtl,
              ]}
            >
              {t("activityLog.pagePrev")}
            </Text>
          </Pressable>
          <Text style={[styles.paginationSummary, isRTL && styles.rtl]}>{pageSummaryText}</Text>
          <Pressable
            disabled={loading || pageIndex >= maxPageIndex}
            onPress={() =>
              setPageIndex((p) => {
                const maxP = Math.max(0, Math.ceil((totalCount ?? 0) / PAGE_SIZE) - 1);
                return Math.min(maxP, p + 1);
              })
            }
            style={({ pressed }) => [
              styles.paginationBtn,
              (loading || pageIndex >= maxPageIndex) && styles.paginationBtnDisabled,
              pressed && !(loading || pageIndex >= maxPageIndex) && styles.paginationBtnPressed,
            ]}
          >
            <Text
              style={[
                styles.paginationBtnText,
                (loading || pageIndex >= maxPageIndex) && styles.paginationBtnTextDisabled,
                isRTL && styles.rtl,
              ]}
            >
              {t("activityLog.pageNext")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        style={styles.listFlex}
        data={rows}
        keyExtractor={(i) => i.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.cta} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 32 }} color={theme.colors.cta} />
          ) : (
            <Text style={styles.empty}>{language === "he" ? "אין רשומות" : "No events yet"}</Text>
          )
        }
        ListFooterComponent={listFooter}
        renderItem={({ item }) => {
            const details = buildDetailLines(item, profileLabels, sessionSummaries, language);
            const actorLine = item.actor_user_id
              ? `${language === "he" ? "מבצע" : "Actor"}: ${profileLabels[item.actor_user_id] ?? `${item.actor_user_id.slice(0, 8)}…`}`
              : "—";
            return (
              <View style={styles.card}>
                <Text style={[styles.when, isRTL && styles.rtl]}>{formatWhen(item.created_at, language)}</Text>
                <Text style={[styles.event, isRTL && styles.rtl]}>{eventLabel(item.event_type, language)}</Text>
                <Text style={[styles.meta, isRTL && styles.rtl]} selectable>
                  {actorLine}
                </Text>
                {details.length > 0 ? (
                  <View style={styles.detailsBox}>
                    <Text style={[styles.detailsTitle, isRTL && styles.rtl]}>
                      {language === "he" ? "פרטים" : "Details"}
                    </Text>
                    {details.map((line, idx) => (
                      <Text key={idx} style={[styles.detailLine, isRTL && styles.rtl]} selectable>
                        {line}
                      </Text>
                    ))}
                  </View>
                ) : item.metadata && Object.keys(item.metadata).length > 0 ? (
                  <Text style={[styles.json, isRTL && styles.rtl]} selectable numberOfLines={6}>
                    {JSON.stringify(item.metadata, null, 0)}
                  </Text>
                ) : null}
              </View>
            );
          }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  listFlex: { flex: 1 },
  listHeaderPad: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.xs },
  title: { fontSize: 20, fontWeight: "900", color: theme.colors.text, letterSpacing: -0.3 },
  hint: {
    marginTop: 8,
    color: theme.colors.textMuted,
    lineHeight: 20,
    marginBottom: theme.spacing.md,
    fontSize: 14,
  },
  headerBlock: { marginBottom: theme.spacing.md },
  filterCard: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  sectionLabelSpaced: { marginTop: theme.spacing.md },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    rowGap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  chipActive: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  chipPressed: { opacity: 0.88 },
  chipCompact: { paddingHorizontal: 12, paddingVertical: 7 },
  chipLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  chipLabelCompact: { fontSize: 12 },
  chipLabelActive: { color: theme.colors.ctaText },
  customDates: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  dateField: { flex: 1, minWidth: 0 },
  retentionShell: {
    marginTop: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  retentionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  retentionHeaderRtl: { flexDirection: "row-reverse" },
  retentionHeaderPressed: { opacity: 0.92 },
  retentionHeaderMain: { flex: 1, minWidth: 0 },
  retentionHeaderMainRtl: { alignItems: "flex-end" },
  retentionHeaderTitle: {
    fontSize: 11,
    fontWeight: "900",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  retentionHeaderSummary: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.text,
  },
  retentionHeaderHint: {
    marginTop: 4,
    fontSize: 12,
    color: theme.colors.textMuted,
    lineHeight: 17,
  },
  retentionChevron: {
    fontSize: 12,
    color: theme.colors.textSoft,
    marginTop: 2,
  },
  retentionBody: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
  },
  retentionCaption: {
    fontSize: 13,
    color: theme.colors.textMuted,
    lineHeight: 19,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  retentionSaveBtn: { marginTop: theme.spacing.md },
  rtl: { textAlign: "right" },
  list: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  card: {
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  when: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft },
  event: { marginTop: 4, fontSize: 16, fontWeight: "900", color: theme.colors.text },
  meta: { marginTop: 6, fontSize: 12, color: theme.colors.textMuted },
  detailsBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  detailsTitle: { fontSize: 11, fontWeight: "900", color: theme.colors.textSoft, marginBottom: 6, textTransform: "uppercase" },
  detailLine: { fontSize: 13, color: theme.colors.text, lineHeight: 20, marginBottom: 4 },
  json: { marginTop: 8, fontSize: 11, color: theme.colors.textMuted, fontFamily: undefined },
  empty: { textAlign: "center", marginTop: 40, color: theme.colors.textSoft },
  listFooterWrap: { marginTop: theme.spacing.sm },
  paginationBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  paginationBarRtl: { flexDirection: "row-reverse" },
  paginationBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  paginationBtnPressed: { opacity: 0.9 },
  paginationBtnDisabled: { opacity: 0.45 },
  paginationBtnText: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  paginationBtnTextDisabled: { color: theme.colors.textMuted },
  paginationSummary: {
    flex: 1,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
});
