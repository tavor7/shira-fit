import { useCallback, useState } from "react";
import { FlatList, Text, View, Pressable, StyleSheet, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";

type Row = { user_id: string; username: string; full_name: string; phone: string };

export default function ApproveAthletesScreen() {
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, full_name, phone")
      .eq("role", "athlete")
      .eq("approval_status", "pending");
    setRows((data as Row[]) ?? []);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function setStatus(uid: string, status: "approved" | "rejected") {
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: status,
    });
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) load();
    else Alert.alert("Failed", data?.error ?? "");
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Pending athletes</Text>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No pending</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.n}>{item.full_name}</Text>
            <Text style={styles.m}>{item.username} · {item.phone}</Text>
            <View style={styles.actions}>
              <Pressable style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }]} onPress={() => setStatus(item.user_id, "approved")}>
                <Text style={styles.okT}>Approve</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.no, pressed && { opacity: 0.9 }]} onPress={() => setStatus(item.user_id, "rejected")}>
                <Text style={styles.noT}>Reject</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  title: { fontSize: 18, fontWeight: "700", padding: theme.spacing.md, color: theme.colors.text },
  list: { paddingBottom: theme.spacing.xl },
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  n: { fontWeight: "700", color: theme.colors.text },
  m: { color: theme.colors.textMuted, marginTop: 4 },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  ok: { flex: 1, backgroundColor: theme.colors.success, padding: 12, borderRadius: theme.radius.md, alignItems: "center" },
  okT: { color: "#fff", fontWeight: "600" },
  no: { flex: 1, backgroundColor: theme.colors.errorBg, padding: 12, borderRadius: theme.radius.md, alignItems: "center", borderWidth: 1, borderColor: theme.colors.errorBorder },
  noT: { color: theme.colors.error, fontWeight: "600" },
  empty: { textAlign: "center", marginTop: 48, color: theme.colors.textSoft },
});
