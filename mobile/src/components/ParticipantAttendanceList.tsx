import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { isBirthdayToday } from "../lib/birthday";

type RegRow = {
  user_id: string;
  attended: boolean | null;
  profiles:
    | { full_name: string; username: string; date_of_birth?: string | null }
    | { full_name: string; username: string; date_of_birth?: string | null }[]
    | null;
};

type ManualRow = {
  manual_participant_id: string;
  attended: boolean | null;
  manual_participants:
    | { full_name: string; phone: string; date_of_birth?: string | null }
    | { full_name: string; phone: string; date_of_birth?: string | null }[]
    | null;
};

type Row =
  | { kind: "registered"; id: string; name: string; attended: boolean | null; userId: string; birthdayToday: boolean }
  | { kind: "manual"; id: string; name: string; phone: string; attended: boolean | null; manualId: string; birthdayToday: boolean };

type AttendanceStatus = "unset" | "arrived" | "absent";

type Props = {
  sessionId: string;
  onChanged?: () => void;
  /** Increment when registrations change (add/remove) so the list reloads without leaving the screen. */
  refreshNonce?: number;
  /** Manager-only: show remove control */
  onRemoveAthlete?: (userId: string) => void | Promise<void>;
};

export function ParticipantAttendanceList({ sessionId, onChanged, refreshNonce = 0, onRemoveAthlete }: Props) {
  const { language, t, isRTL } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("session_registrations")
      .select("user_id, attended, profiles(full_name, username, date_of_birth)")
      .eq("session_id", sessionId)
      .eq("status", "active");
    const { data: mData, error: mErr } = await supabase
      .from("session_manual_participants")
      .select("manual_participant_id, attended, manual_participants(full_name, phone, date_of_birth)")
      .eq("session_id", sessionId);

    if (error && mErr) {
      setRows([]);
      setLoading(false);
      return;
    }

    const regRows: Row[] = ((data as unknown as RegRow[]) ?? []).map((r) => {
      const p = r.profiles ? (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles) : null;
      return {
        kind: "registered",
        id: `u:${r.user_id}`,
        userId: r.user_id,
        name: p?.full_name ?? "—",
        attended: r.attended ?? null,
        birthdayToday: isBirthdayToday(p?.date_of_birth ?? null),
      };
    });

    const manualRows: Row[] = ((mData as unknown as ManualRow[]) ?? []).map((r) => {
      const p = r.manual_participants ? (Array.isArray(r.manual_participants) ? r.manual_participants[0] : r.manual_participants) : null;
      return {
        kind: "manual",
        id: `m:${r.manual_participant_id}`,
        manualId: r.manual_participant_id,
        name: p?.full_name ?? "—",
        phone: p?.phone ?? "",
        attended: r.attended ?? null,
        birthdayToday: isBirthdayToday(p?.date_of_birth ?? null),
      };
    });

    const all = [...regRows, ...manualRows].sort((a, b) => a.name.localeCompare(b.name));
    setRows(all);
    setLoading(false);
  }, [sessionId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    if (refreshNonce > 0) load();
  }, [refreshNonce, load]);

  async function setStatus(row: Row, status: AttendanceStatus) {
    const key = row.id;
    setBusyKey(key);
    const { data, error } =
      row.kind === "registered"
        ? await supabase.rpc("set_registration_attendance", {
            p_session_id: sessionId,
            p_user_id: row.userId,
            p_status: status,
          })
        : await supabase.rpc("set_manual_participant_attendance", {
            p_session_id: sessionId,
            p_manual_participant_id: row.manualId,
            p_status: status,
          });
    setBusyKey(null);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(language === "he" ? "לא ניתן לשמור" : "Could not save", data?.error ?? "");
      return;
    }
    await load();
    onChanged?.();
  }

  if (loading) {
    return <ActivityIndicator color={theme.colors.cta} style={styles.loader} />;
  }

  if (rows.length === 0) {
    return <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין הרשמות פעילות." : "No active registrations."}</Text>;
  }

  return (
    <View style={styles.list}>
      {rows.map((item) => {
        const current: AttendanceStatus =
          item.attended === true ? "arrived" : item.attended === false ? "absent" : "unset";
        const busy = busyKey === item.id;
        return (
          <View key={item.id} style={styles.card}>
            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>
                  {item.name}
                  {item.birthdayToday ? <Text style={styles.bday}>{"  "}🎂</Text> : null}
                </Text>
                {item.kind === "manual" && item.phone ? <Text style={styles.sub}>{item.phone}</Text> : null}
              </View>
              <View style={styles.nameRight}>
                {busy ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
                {!busy ? (
                  <Pressable
                    onPress={() =>
                      item.kind === "registered"
                        ? router.push(`/(app)/staff/profile/${item.userId}` as never)
                        : router.push(`/(app)/staff/manual/${item.manualId}` as never)
                    }
                    hitSlop={8}
                    style={({ pressed }) => pressed && { opacity: 0.7 }}
                  >
                    <Text style={styles.edit}>{language === "he" ? "עריכה" : "Edit"}</Text>
                  </Pressable>
                ) : null}
                {item.kind === "registered" && onRemoveAthlete && !busy ? (
                  <Pressable
                    onPress={() => onRemoveAthlete(item.userId)}
                    hitSlop={8}
                    style={({ pressed }) => pressed && { opacity: 0.7 }}
                  >
                    <Text style={styles.remove}>{language === "he" ? "הסרה" : "Remove"}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{language === "he" ? "נוכחות" : "Attendance"}</Text>
            <View style={styles.seg}>
              {(["unset", "arrived", "absent"] as const).map((st) => (
                <Pressable
                  key={st}
                  disabled={busy}
                  onPress={() => setStatus(item, st)}
                  style={({ pressed }) => [
                    styles.segBtn,
                    current === st && styles.segBtnOn,
                    pressed && styles.segBtnPressed,
                  ]}
                >
                  <Text style={[styles.segTxt, current === st && styles.segTxtOn]}>
                    {st === "unset"
                      ? language === "he"
                        ? "לא סומן"
                        : "Not set"
                      : st === "arrived"
                        ? language === "he"
                          ? "הגיע"
                          : "Arrived"
                        : language === "he"
                          ? "נעדר"
                          : "Absent"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: theme.spacing.md },
  muted: { color: theme.colors.textMuted, fontStyle: "italic", marginVertical: 8 },
  rtlText: { textAlign: "right" },
  list: { gap: theme.spacing.sm },
  card: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  nameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.text },
  bday: { color: theme.colors.cta, fontWeight: "900" },
  sub: { marginTop: 2, color: theme.colors.textMuted, fontSize: 12 },
  nameRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  edit: { color: theme.colors.cta, fontWeight: "800", fontSize: 14 },
  remove: { color: theme.colors.error, fontWeight: "700", fontSize: 14 },
  hint: { marginTop: 8, fontSize: 12, color: theme.colors.textMuted, fontWeight: "600" },
  seg: { flexDirection: "row", marginTop: 8, gap: 6, flexWrap: "wrap" },
  segBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  segBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  segBtnPressed: { opacity: 0.85 },
  segTxt: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  segTxtOn: { color: theme.colors.ctaText },
});
