import { useCallback, useState } from "react";
import { FlatList, Text, View, Pressable, StyleSheet, Alert } from "react-native";
import { useFocusEffect, Stack } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";

type Row = { user_id: string; username: string; full_name: string; phone: string };

export default function ApproveAthletesScreen() {
  const { language, t, isRTL } = useI18n();
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

  async function approveAthlete(uid: string) {
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: "approved",
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) load();
    else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.managerApprove") }} />
      <Text style={[styles.title, isRTL && { textAlign: "right" }]}>
        {language === "he" ? "מתאמנים בהמתנה" : "Pending athletes"}
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>{language === "he" ? "אין ממתינים" : "No pending"}</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.n}>{item.full_name}</Text>
            <Text style={styles.m}>{item.username} · {item.phone}</Text>
            <View style={styles.actions}>
              <Pressable style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }]} onPress={() => approveAthlete(item.user_id)}>
                <Text style={styles.okT}>{language === "he" ? "אישור" : "Approve"}</Text>
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
  empty: { textAlign: "center", marginTop: 48, color: theme.colors.textSoft },
});
