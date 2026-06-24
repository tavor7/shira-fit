import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { AppSearchField } from "../components/AppSearchField";
import { useSearchListBottomPadding } from "../hooks/useSearchListBottomPadding";

type ProfileRow = {
  kind: "profile";
  user_id: string;
  full_name: string;
  username: string;
  phone: string;
  role: "athlete" | "coach" | "manager";
  approval_status: "pending" | "approved" | "rejected";
  disabled_at?: string | null;
  date_of_birth?: string | null;
};

type ManualRow = {
  kind: "manual";
  id: string;
  full_name: string;
  phone: string;
  gender?: string | null;
  date_of_birth?: string | null;
};

type Row = ProfileRow | ManualRow;

export default function StaffUsersScreen() {
  const { profile } = useAuth();
  const isManager = profile?.role === "manager";
  const { t, isRTL } = useI18n();

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [duplicateNameCounts, setDuplicateNameCounts] = useState<Record<string, number>>({});
  const listBottomPad = useSearchListBottomPadding();

  function normalizeFullName(name: string): string {
    return name.trim().toLowerCase();
  }

  const loadDuplicateNameCounts = useCallback(async () => {
    let query = supabase.from("profiles").select("full_name");
    query = isManager ? query.in("role", ["athlete", "coach"]) : query.eq("role", "athlete");
    const { data, error } = await query;
    if (error) {
      setDuplicateNameCounts({});
      return;
    }
    const counts: Record<string, number> = {};
    for (const row of (data as { full_name?: string }[]) ?? []) {
      const key = normalizeFullName(row.full_name ?? "");
      if (!key) continue;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    setDuplicateNameCounts(counts);
  }, [isManager]);

  const load = useCallback(async (termRaw?: string) => {
    const qTrim = (termRaw ?? q).trim();
    setLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone, role, approval_status, date_of_birth, disabled_at")
      .order("full_name", { ascending: true })
      .limit(200);

    // Coaches: only athletes (by requirement: can't edit managers; and coaches shouldn't edit other coaches)
    // Managers: athletes + coaches (but not managers).
    query = isManager ? query.in("role", ["athlete", "coach"]) : query.eq("role", "athlete");

    if (qTrim.length > 0) {
      query = query.or(`full_name.ilike.%${qTrim}%,username.ilike.%${qTrim}%,phone.ilike.%${qTrim}%`);
    }

    const { data, error } = await query;
    if (error) {
      Alert.alert(t("common.error"), error.message);
      setRows([]);
      setLoading(false);
      return;
    }

    const { data: manuals, error: mErr } = await supabase
      .from("manual_participants")
      .select("id, full_name, phone, gender, date_of_birth")
      .limit(200);

    if (mErr) {
      // If manual participants query fails, still show profiles.
      setRows(((data as any[]) ?? []).map((p) => ({ kind: "profile", ...p })) as Row[]);
      setLoading(false);
      return;
    }

    const qManual = qTrim.length > 0 ? qTrim : "";
    const filteredManuals = !qManual
      ? (manuals as any[])
      : (manuals as any[]).filter((m) => {
          const s = `${m.full_name ?? ""} ${m.phone ?? ""}`.toLowerCase();
          return s.includes(qManual.toLowerCase());
        });

    const mappedProfiles = ((data as any[]) ?? []).map((p) => ({ kind: "profile" as const, ...p })) as ProfileRow[];
    const mappedManuals = ((filteredManuals as any[]) ?? []).map(
      (m) =>
        ({
          kind: "manual" as const,
          id: m.id,
          full_name: m.full_name,
          phone: m.phone,
          gender: m.gender,
          date_of_birth: m.date_of_birth,
        }) as ManualRow
    );

    const combined: Row[] = [...mappedManuals, ...mappedProfiles];
    combined.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    setRows(combined);
    setLoading(false);
  }, [isManager, q, t]);

  useEffect(() => {
    void load(q);
    void loadDuplicateNameCounts();
  }, [isManager]);

  useFocusEffect(
    useCallback(() => {
      void loadDuplicateNameCounts();
    }, [loadDuplicateNameCounts])
  );

  const subtitle = useMemo(() => {
    return isManager ? t("staffUsers.hintManager") : t("staffUsers.hintCoach");
  }, [isManager, t]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(i) => (i.kind === "profile" ? i.user_id : `manual:${i.id}`)}
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.top}>
            {isManager ? <ManagerStudioSetupTabs /> : null}
            <Text style={[styles.title, isRTL && styles.rtlText]}>{t("screen.staffUsers")}</Text>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{subtitle}</Text>
            <AppSearchField
              value={q}
              onChangeText={setQ}
              onSearch={(term) => void load(term)}
              placeholder={t("staffUsers.searchPlaceholder")}
              isRTL={isRTL}
              loading={loading}
            />
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, isRTL && styles.rtlText]}>
            {loading ? t("common.loading") : t("staffUsers.noUsers")}
          </Text>
        }
        renderItem={({ item }) => {
          const nameKey = normalizeFullName(item.full_name ?? "");
          const sameNameCount = item.kind === "profile" ? (duplicateNameCounts[nameKey] ?? 0) : 0;
          const hasDuplicateName = sameNameCount > 1;
          return (
          <Pressable
            onPress={() => {
              if (item.kind === "profile") router.push(`/(app)/staff/profile/${item.user_id}` as never);
              else router.push(`/(app)/staff/manual/${item.id}` as never);
            }}
            style={({ pressed }) => [
              styles.card,
              hasDuplicateName && styles.cardDuplicateName,
              pressed && { opacity: 0.9 },
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.name}>
              {item.full_name}
              {(() => {
                const dob = (item as any).date_of_birth as string | null | undefined;
                if (!dob || dob.length < 10) return null;
                const md = dob.slice(5, 10);
                const now = new Date();
                const tmd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
                return md === tmd ? <Text style={styles.bday}>{"  "}🎂</Text> : null;
              })()}
            </Text>
            {hasDuplicateName ? (
              <Text style={[styles.duplicateBadge, isRTL && styles.rtlText]}>
                {t("profile.duplicateNameBadge").replace("{n}", String(sameNameCount))}
              </Text>
            ) : null}
            <Text style={styles.meta}>
              {item.kind === "profile"
                ? `${t("profile.username")}: @${item.username} · ${item.phone} · ${item.role} · ${item.approval_status}${
                    item.disabled_at ? ` · ${t("profile.accountDisabledBadge")}` : ""
                  }`
                : `${item.phone} · ${t("pricing.quickAddLabel")}`}
            </Text>
          </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  top: {
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
  },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  hint: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18, fontSize: 12 },
  rtlText: { textAlign: "right" },
  list: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  empty: { textAlign: "center", marginTop: 32, color: theme.colors.textSoft },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  cardDuplicateName: {
    borderColor: theme.colors.cta,
    backgroundColor: "rgba(96, 165, 250, 0.08)",
  },
  duplicateBadge: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.cta,
    lineHeight: 16,
  },
  name: { color: theme.colors.text, fontWeight: "900", fontSize: 15 },
  bday: { color: theme.colors.cta, fontWeight: "900" },
  meta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
});

