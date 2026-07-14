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
  const { showOk, showConfirm } = useAppAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, full_name, phone")
      .eq("role", "athlete")
      .eq("approval_status", "pending");
    setRows((data as Row[]) ?? []);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function setApproval(uid: string, status: "approved" | "rejected") {
    if (busyId) return;
    setBusyId(uid);
    const { data, error } = await supabase.rpc("set_athlete_approval", {
      p_user_id: uid,
      p_status: status,
    });
    setBusyId(null);
    if (error) showOk(t("common.error"), error.message);
    else if (data?.ok) load();
    else showOk(t("common.failed"), data?.error ?? "");
  }

  function confirmReject(row: Row) {
    showConfirm({
      title: t("approve.rejectConfirmTitle"),
      message: t("approve.rejectConfirmMessage").replace("{name}", row.full_name),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("approve.rejectBtn"),
      confirmVariant: "danger",
      onConfirm: () => void setApproval(row.user_id, "rejected"),
    });
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
                style={({ pressed }) => [styles.ok, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => void setApproval(item.user_id, "approved")}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.okT}>
                  {busyId === item.user_id ? t("common.loading") : t("approve.approveBtn")}
                </AppText>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.reject, pressed && { opacity: 0.9 }, busyId === item.user_id && { opacity: 0.6 }]}
                onPress={() => confirmReject(item)}
                disabled={busyId !== null}
              >
                <AppText variant="label" style={styles.rejectT}>
                  {t("approve.rejectBtn")}
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
  reject: {
    flex: 1,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  rejectT: { color: theme.colors.error },
});
