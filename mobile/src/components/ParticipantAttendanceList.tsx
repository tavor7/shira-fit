import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";

type Row = {
  user_id: string;
  attended: boolean | null;
  profiles: { full_name: string; username: string } | { full_name: string; username: string }[] | null;
};

type AttendanceStatus = "unset" | "arrived" | "absent";

function profileName(p: Row["profiles"]): string {
  if (!p) return "—";
  const one = Array.isArray(p) ? p[0] : p;
  return one?.full_name ?? "—";
}

type Props = {
  sessionId: string;
  onChanged?: () => void;
  /** Increment when registrations change (add/remove) so the list reloads without leaving the screen. */
  refreshNonce?: number;
  /** Manager-only: show remove control */
  onRemoveAthlete?: (userId: string) => void | Promise<void>;
};

export function ParticipantAttendanceList({ sessionId, onChanged, refreshNonce = 0, onRemoveAthlete }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("session_registrations")
      .select("user_id, attended, profiles(full_name, username)")
      .eq("session_id", sessionId)
      .eq("status", "active");
    if (error) {
      setRows([]);
      setLoading(false);
      return;
    }
    setRows((data as unknown as Row[]) ?? []);
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

  async function setStatus(userId: string, status: AttendanceStatus) {
    setBusyUserId(userId);
    const { data, error } = await supabase.rpc("set_registration_attendance", {
      p_session_id: sessionId,
      p_user_id: userId,
      p_status: status,
    });
    setBusyUserId(null);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert("Could not save", data?.error ?? "");
      return;
    }
    await load();
    onChanged?.();
  }

  if (loading) {
    return <ActivityIndicator color={theme.colors.cta} style={styles.loader} />;
  }

  if (rows.length === 0) {
    return <Text style={styles.muted}>No active registrations.</Text>;
  }

  return (
    <View style={styles.list}>
      {rows.map((item) => {
        const current: AttendanceStatus =
          item.attended === true ? "arrived" : item.attended === false ? "absent" : "unset";
        const busy = busyUserId === item.user_id;
        return (
          <View key={item.user_id} style={styles.card}>
            <View style={styles.nameRow}>
              <Text style={styles.name}>{profileName(item.profiles)}</Text>
              <View style={styles.nameRight}>
                {busy ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
                {onRemoveAthlete && !busy ? (
                  <Pressable
                    onPress={() => onRemoveAthlete(item.user_id)}
                    hitSlop={8}
                    style={({ pressed }) => pressed && { opacity: 0.7 }}
                  >
                    <Text style={styles.remove}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={styles.hint}>Attendance</Text>
            <View style={styles.seg}>
              {(["unset", "arrived", "absent"] as const).map((st) => (
                <Pressable
                  key={st}
                  disabled={busy}
                  onPress={() => setStatus(item.user_id, st)}
                  style={({ pressed }) => [
                    styles.segBtn,
                    current === st && styles.segBtnOn,
                    pressed && styles.segBtnPressed,
                  ]}
                >
                  <Text style={[styles.segTxt, current === st && styles.segTxtOn]}>
                    {st === "unset" ? "Not set" : st === "arrived" ? "Arrived" : "Absent"}
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
  nameRight: { flexDirection: "row", alignItems: "center", gap: 10 },
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
