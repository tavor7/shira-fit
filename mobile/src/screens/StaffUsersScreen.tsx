import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";

type Row = {
  user_id: string;
  full_name: string;
  username: string;
  phone: string;
  role: "athlete" | "coach" | "manager";
  approval_status: "pending" | "approved" | "rejected";
};

export default function StaffUsersScreen() {
  const { profile } = useAuth();
  const isManager = profile?.role === "manager";

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const qTrim = q.trim();

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone, role, approval_status")
      .order("full_name", { ascending: true })
      .limit(200);

    // Coaches: only athletes (by requirement: can't edit managers; and coaches shouldn't edit other coaches)
    // Managers: athletes + coaches (but not managers).
    query = isManager ? query.in("role", ["athlete", "coach"]) : query.eq("role", "athlete");

    if (qTrim.length > 0) {
      query = query.or(`full_name.ilike.%${qTrim}%,username.ilike.%${qTrim}%,phone.ilike.%${qTrim}%`);
    }

    const { data, error } = await query;
    setLoading(false);
    if (error) {
      Alert.alert("Error", error.message);
      setRows([]);
      return;
    }
    setRows((data as Row[]) ?? []);
  }, [isManager, qTrim]);

  useEffect(() => {
    load();
  }, [load]);

  const subtitle = useMemo(() => {
    return isManager
      ? "Search athletes and coaches (managers hidden). Tap a user to edit."
      : "Search athletes. Tap a user to edit.";
  }, [isManager]);

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={styles.title}>Users</Text>
        <Text style={styles.hint}>{subtitle}</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search name / username / phone…"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
          autoCapitalize="none"
          onSubmitEditing={load}
        />
        <Pressable style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.9 }]} onPress={load}>
          <Text style={styles.searchBtnTxt}>{loading ? "Loading…" : "Search"}</Text>
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>{loading ? "Loading…" : "No users found."}</Text>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/(app)/staff/profile/${item.user_id}` as never)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
            accessibilityRole="button"
          >
            <Text style={styles.name}>{item.full_name}</Text>
            <Text style={styles.meta}>
              @{item.username} · {item.phone} · {item.role} · {item.approval_status}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  top: { padding: theme.spacing.md, borderBottomWidth: 1, borderBottomColor: theme.colors.borderMuted },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  hint: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18, fontSize: 12 },
  input: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  searchBtn: {
    marginTop: theme.spacing.sm,
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  searchBtnTxt: { color: theme.colors.ctaText, fontWeight: "900" },
  list: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  empty: { textAlign: "center", marginTop: 32, color: theme.colors.textSoft },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
  },
  name: { color: theme.colors.text, fontWeight: "900", fontSize: 15 },
  meta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
});

