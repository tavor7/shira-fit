import { useCallback, useState } from "react";
import { FlatList, View, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, Stack } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";
import { useAppAlert } from "../../../src/context/AppAlertContext";
import { AppText } from "../../../src/components/AppText";
import { EmptyState } from "../../../src/components/EmptyState";

type Row = { user_id: string; username: string; full_name: string; phone: string };

export default function ApproveAthletesScreen() {
  const { t, isRTL } = useI18n();
  const { showOk } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

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
    if (approvingId) return;
    setApprovingId(uid);
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: "approved",
    });
    setApprovingId(null);
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) load();
    else showOk(t("common.failed"), data?.error ?? "");
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("screen.managerApprove") }} />
      <AppText variant="headline" isRTL={isRTL} style={styles.title}>
        {t("approve.title")}
      </AppText>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<EmptyState title={t("approve.empty")} isRTL={isRTL} />}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <AppText variant="title">{item.full_name}</AppText>
            <AppText variant="caption" muted style={styles.meta}>
              {item.username} · {item.phone}
            </AppText>
            <View style={styles.actions}>
              <Pressable
                style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }, approvingId === item.user_id && { opacity: 0.6 }]}
                onPress={() => approveAthlete(item.user_id)}
                disabled={approvingId !== null}
              >
                <AppText variant="label" style={styles.okT}>
                  {approvingId === item.user_id ? t("common.loading") : t("approve.approveBtn")}
                </AppText>
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
  title: { padding: theme.spacing.md },
  list: { paddingBottom: theme.spacing.xl, flexGrow: 1 },
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  meta: { marginTop: theme.spacing.xs },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  ok: { flex: 1, backgroundColor: theme.colors.success, padding: theme.spacing.sm, borderRadius: theme.radius.md, alignItems: "center" },
  okT: { color: theme.colors.white },
});
