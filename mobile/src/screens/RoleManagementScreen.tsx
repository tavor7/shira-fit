import { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";

type Role = "athlete" | "coach" | "manager";
type Row = {
  user_id: string;
  username: string;
  full_name: string;
  phone: string;
  role: Role;
  approval_status: "pending" | "approved" | "rejected";
};

export default function RoleManagementScreen() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const qTrim = q.trim();

  const load = useCallback(async () => {
    setLoading(true);
    // Manager policy allows reading all profiles; keep search simple.
    let query = supabase
      .from("profiles")
      .select("user_id, username, full_name, phone, role, approval_status")
      .order("full_name", { ascending: true })
      .limit(200);

    if (qTrim.length > 0) {
      // Search across multiple fields.
      const esc = qTrim.replace(/,/g, " ");
      query = query.or(`full_name.ilike.%${esc}%,username.ilike.%${esc}%,phone.ilike.%${esc}%`);
    }

    const { data, error } = await query;
    setLoading(false);
    if (error) {
      Alert.alert("Error", error.message);
      setRows([]);
      return;
    }
    setRows((data as Row[]) ?? []);
  }, [qTrim]);

  const filtered = useMemo(() => rows, [rows]);

  async function setRole(userId: string, role: Role) {
    const { data, error } = await supabase.rpc("set_user_role", { p_user_id: userId, p_role: role });
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert("Failed", data?.error ?? "Unknown error");
      return;
    }
    load();
  }

  function RoleChip({ label, onPress, active }: { label: string; onPress: () => void; active: boolean }) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.chip, active ? styles.chipActive : styles.chipInactive, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
      >
        <Text style={[styles.chipTxt, active ? styles.chipTxtActive : styles.chipTxtInactive]}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={styles.title}>Roles</Text>
        <Text style={styles.hint}>Search by name, username, or phone. Managers can promote/demote roles.</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search…"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
          autoCapitalize="none"
        />
        <Pressable onPress={load} style={({ pressed }) => [styles.loadBtn, pressed && { opacity: 0.9 }]}>
          <Text style={styles.loadTxt}>{loading ? "Loading…" : "Load"}</Text>
        </Pressable>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>{loading ? "Loading…" : "No users found."}</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.name}>{item.full_name}</Text>
            <Text style={styles.meta}>
              @{item.username} · {item.phone} · {item.approval_status}
            </Text>
            <View style={styles.row}>
              <RoleChip label="Athlete" active={item.role === "athlete"} onPress={() => setRole(item.user_id, "athlete")} />
              <RoleChip label="Coach" active={item.role === "coach"} onPress={() => setRole(item.user_id, "coach")} />
              <RoleChip label="Manager" active={item.role === "manager"} onPress={() => setRole(item.user_id, "manager")} />
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  top: { padding: theme.spacing.md, borderBottomWidth: 1, borderBottomColor: theme.colors.borderMuted },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  hint: { marginTop: 6, fontSize: 12, lineHeight: 18, color: theme.colors.textMuted },
  input: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  loadBtn: {
    marginTop: theme.spacing.sm,
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  loadTxt: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 13 },
  list: { paddingVertical: theme.spacing.sm, paddingBottom: theme.spacing.xl },
  empty: { textAlign: "center", marginTop: 32, color: theme.colors.textSoft },
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  name: { fontWeight: "800", color: theme.colors.text, fontSize: 15 },
  meta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
  row: { marginTop: theme.spacing.sm, flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.radius.full, borderWidth: 1 },
  chipActive: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  chipInactive: { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.borderMuted },
  chipTxt: { fontWeight: "800", fontSize: 12, letterSpacing: 0.2 },
  chipTxtActive: { color: theme.colors.ctaText },
  chipTxtInactive: { color: theme.colors.text },
});

