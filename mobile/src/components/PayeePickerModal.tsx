import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { supabase } from "../lib/supabase";
import { athleteSearchSubtitle } from "../lib/displayName";
import { AppModal } from "./AppModal";
import { AppSearchField } from "./AppSearchField";
import { EmptyState } from "./EmptyState";

export type PayeePickerRow =
  | { kind: "app"; id: string; full_name: string; username?: string; phone?: string }
  | { kind: "manual"; id: string; full_name: string; phone?: string; linked_user_id?: string | null };

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (row: PayeePickerRow) => void;
};

/** Searchable athlete + quick-add picker, reused wherever a payment/receipt list needs a
 * "filter by payee" control (Payments received, Pending receipts, Documents). */
export function PayeePickerModal({ visible, onClose, onSelect }: Props) {
  const { t, isRTL } = useI18n();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<PayeePickerRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setLoading(true);

    let profileQuery = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(80);
    if (q) profileQuery = profileQuery.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);

    let manualQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .is("disabled_at", null)
      .order("full_name", { ascending: true })
      .limit(80);
    if (q) manualQuery = manualQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);

    const [profilesRes, manualRes] = await Promise.all([profileQuery, manualQuery]);
    setLoading(false);

    const athletes: PayeePickerRow[] = (
      (profilesRes.data ?? []) as { user_id: string; full_name: string; username?: string; phone?: string }[]
    ).map((p) => ({ kind: "app" as const, id: p.user_id, full_name: p.full_name, username: p.username, phone: p.phone }));

    const manuals: PayeePickerRow[] = (
      (manualRes.data ?? []) as { id: string; full_name: string; phone?: string; linked_user_id?: string | null }[]
    )
      .filter((m) => !m.linked_user_id)
      .map((m) => ({ kind: "manual" as const, id: m.id, full_name: m.full_name, phone: m.phone }));

    setRows([...manuals, ...athletes]);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    void load("");
  }, [visible, load]);

  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="sheet"
      backdropAccessibilityLabel={t("common.cancel")}
      cardStyle={styles.sheet}
    >
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{t("accountPayments.pickPayeeFilter")}</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>{t("common.cancel")}</Text>
        </Pressable>
      </View>
      <View style={styles.body}>
        <AppSearchField
          value={query}
          onChangeText={setQuery}
          onSearch={(term) => void load(term)}
          placeholder={t("payeeFilter.search")}
          isRTL={isRTL}
        />
        {loading ? (
          <ActivityIndicator style={styles.loading} color={theme.colors.cta} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => `${r.kind}:${r.id}`}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListEmptyComponent={<EmptyState icon="🔍" title={t("accountPayments.noPayees")} isRTL={isRTL} />}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                <Text style={[styles.rowTitle, isRTL && styles.rtl]} numberOfLines={1}>
                  {item.full_name}
                </Text>
                <Text style={[styles.rowSub, isRTL && styles.rtl]} numberOfLines={1}>
                  {item.kind === "manual" ? t("accountPayments.kindManual") : athleteSearchSubtitle(item.phone)}
                </Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: "85%" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flex: 1 },
  close: { fontSize: 15, fontWeight: "800", color: theme.colors.textMuted },
  body: { padding: theme.spacing.md, flex: 1, minHeight: 280 },
  loading: { marginTop: theme.spacing.lg },
  list: { marginTop: theme.spacing.sm, maxHeight: 400 },
  row: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceElevated },
  rowTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  rowSub: { marginTop: 2, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  rtl: { textAlign: "right" },
});
