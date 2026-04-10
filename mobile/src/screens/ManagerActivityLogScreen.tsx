import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";

type Row = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
};

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

async function fetchActorDisplayNames(userIds: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter((id): id is string => !!id))];
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
  const { language, isRTL } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [actorLabels, setActorLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("user_activity_events")
      .select("id, created_at, actor_user_id, event_type, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(300);
    const list = !error && data ? (data as Row[]) : [];
    setRows(list);
    const labels = await fetchActorDisplayNames(list.map((r) => r.actor_user_id));
    setActorLabels(labels);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [load])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ManagerOverviewTabs />
      <Text style={[styles.title, isRTL && styles.rtl]}>
        {language === "he" ? "יומן פעילות" : "Activity log"}
      </Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>
        {language === "he"
          ? "אירועים מהמערכת עם חותמת זמן (התחברות, פרופיל, אימונים, הרשמות ועוד)."
          : "System events with timestamps (logins, profiles, sessions, registrations, and more)."}
      </Text>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={theme.colors.cta} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.cta} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>{language === "he" ? "אין רשומות" : "No events yet"}</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={[styles.when, isRTL && styles.rtl]}>{formatWhen(item.created_at, language)}</Text>
              <Text style={[styles.event, isRTL && styles.rtl]}>{eventLabel(item.event_type, language)}</Text>
              <Text style={[styles.meta, isRTL && styles.rtl]} selectable>
                {item.actor_user_id
                  ? `${language === "he" ? "מבצע" : "Actor"}: ${actorLabels[item.actor_user_id] ?? `${item.actor_user_id.slice(0, 8)}…`}`
                  : "—"}
                {item.target_type || item.target_id
                  ? ` · ${item.target_type ?? ""}${item.target_id ? ` ${item.target_id.slice(0, 8)}…` : ""}`
                  : ""}
              </Text>
              {item.metadata && Object.keys(item.metadata).length > 0 ? (
                <Text style={[styles.json, isRTL && styles.rtl]} selectable numberOfLines={4}>
                  {JSON.stringify(item.metadata)}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  hint: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 20, marginBottom: theme.spacing.sm },
  rtl: { textAlign: "right" },
  list: { paddingBottom: theme.spacing.xl },
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
  json: { marginTop: 8, fontSize: 11, color: theme.colors.textMuted, fontFamily: undefined },
  empty: { textAlign: "center", marginTop: 40, color: theme.colors.textSoft },
});
