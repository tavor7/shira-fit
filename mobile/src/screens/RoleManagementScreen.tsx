import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { AppSearchField } from "../components/AppSearchField";
import { EmptyState } from "../components/EmptyState";
import { ListRowSkeleton } from "../components/ListRowSkeleton";
import { useSearchListBottomPadding } from "../hooks/useSearchListBottomPadding";

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
  const { t, isRTL } = useI18n();
  const { showOk, showConfirm } = useAppAlert();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [changingId, setChangingId] = useState<string | null>(null);
  const listBottomPad = useSearchListBottomPadding();

  const load = useCallback(async (termRaw?: string) => {
    const qTrim = (termRaw ?? q).trim();
    setLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, username, full_name, phone, role, approval_status")
      .order("full_name", { ascending: true })
      .limit(200);

    if (qTrim.length > 0) {
      query = query.or(`full_name.ilike.%${qTrim}%,username.ilike.%${qTrim}%,phone.ilike.%${qTrim}%`);
    }

    const { data, error } = await query;
    setLoading(false);
    if (error) {
      showOk(t("common.error"), error.message);
      setRows([]);
      return;
    }
    setRows((data as Row[]) ?? []);
  }, [q, t, showOk]);

  async function applyRole(userId: string, role: Role) {
    setChangingId(userId);
    const { data, error } = await supabase.rpc("set_user_role", { p_user_id: userId, p_role: role });
    setChangingId(null);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.failed"), data?.error ?? "Unknown error");
      return;
    }
    void load(q);
  }

  function confirmSetRole(row: Row, role: Role) {
    if (role === row.role || changingId) return;
    const roleLabel = role === "athlete" ? t("roles.athlete") : role === "coach" ? t("roles.coach") : t("roles.manager");
    showConfirm({
      title: t("roles.changeConfirmTitle"),
      message: t("roles.changeConfirmMessage").replace("{name}", row.full_name).replace("{role}", roleLabel),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("common.confirm"),
      onConfirm: () => void applyRole(row.user_id, role),
    });
  }

  function RoleChip({
    label,
    onPress,
    active,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    active: boolean;
    disabled: boolean;
  }) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [
          styles.chip,
          active ? styles.chipActive : styles.chipInactive,
          pressed && !disabled && { opacity: 0.9 },
          disabled && !active && { opacity: 0.5 },
        ]}
        accessibilityRole="button"
      >
        <Text style={[styles.chipTxt, active ? styles.chipTxtActive : styles.chipTxtInactive]}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.user_id}
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.top}>
            <ManagerStudioSetupTabs />
            <Text style={[styles.title, isRTL && styles.rtlText]}>{t("menu.roles")}</Text>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("roles.hint")}</Text>
            <AppSearchField
              value={q}
              onChangeText={setQ}
              onSearch={(term) => void load(term)}
              placeholder={t("pricing.searchAthletesPlaceholder")}
              isRTL={isRTL}
              loading={loading}
            />
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.skeletonList}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : (
            <EmptyState title={t("staffUsers.noUsers")} isRTL={isRTL} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.name}>{item.full_name}</Text>
            <Text style={styles.meta}>
              @{item.username} · {item.phone} · {item.approval_status}
            </Text>
            <View style={styles.row}>
              <RoleChip
                label={t("roles.athlete")}
                active={item.role === "athlete"}
                disabled={changingId !== null}
                onPress={() => confirmSetRole(item, "athlete")}
              />
              <RoleChip
                label={t("roles.coach")}
                active={item.role === "coach"}
                disabled={changingId !== null}
                onPress={() => confirmSetRole(item, "coach")}
              />
              <RoleChip
                label={t("roles.manager")}
                active={item.role === "manager"}
                disabled={changingId !== null}
                onPress={() => confirmSetRole(item, "manager")}
              />
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  top: {
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  hint: { marginTop: 6, fontSize: 12, lineHeight: 18, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  skeletonList: { paddingHorizontal: theme.spacing.md, gap: theme.spacing.sm },
  list: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
    flexGrow: 1,
  },
  card: {
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

