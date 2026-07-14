import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { AppSearchField } from "../components/AppSearchField";
import { EmptyState } from "../components/EmptyState";
import { useSearchListBottomPadding } from "../hooks/useSearchListBottomPadding";
import {
  buildManualDuplicateIndexes,
  manualHasDuplicateName,
  manualHasDuplicatePhone,
  normalizeParticipantName,
  type ManualDuplicateIndexes,
} from "../lib/participantIdentity";

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
  disabled_at?: string | null;
};

type Row = ProfileRow | ManualRow;

export default function StaffUsersScreen() {
  const { profile } = useAuth();
  const isManager = profile?.role === "manager";
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [duplicateNameCounts, setDuplicateNameCounts] = useState<Record<string, number>>({});
  const [manualDuplicateIndexes, setManualDuplicateIndexes] = useState<ManualDuplicateIndexes>({
    nameCounts: {},
    phoneCounts: {},
  });
  const listBottomPad = useSearchListBottomPadding();

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
      const key = normalizeParticipantName(row.full_name ?? "");
      if (!key) continue;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    setDuplicateNameCounts(counts);
  }, [isManager]);

  const loadManualDuplicateIndexes = useCallback(async () => {
    const { data, error } = await supabase.from("manual_participants").select("id, full_name, phone");
    if (error) {
      setManualDuplicateIndexes({ nameCounts: {}, phoneCounts: {} });
      return;
    }
    setManualDuplicateIndexes(buildManualDuplicateIndexes((data as ManualRow[]) ?? []));
  }, []);

  const load = useCallback(async (termRaw?: string) => {
    const qTrim = (termRaw ?? q).trim();
    setLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone, role, approval_status, date_of_birth, disabled_at")
      .order("full_name", { ascending: true })
      .limit(200);

    query = isManager ? query.in("role", ["athlete", "coach"]) : query.eq("role", "athlete");

    if (qTrim.length > 0) {
      query = query.or(`full_name.ilike.%${qTrim}%,username.ilike.%${qTrim}%,phone.ilike.%${qTrim}%`);
    }

    const { data, error } = await query;
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      setRows([]);
      setLoading(false);
      return;
    }

    const { data: manuals, error: mErr } = await supabase
      .from("manual_participants")
      .select("id, full_name, phone, gender, date_of_birth, disabled_at")
      .limit(200);

    if (mErr) {
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
          disabled_at: m.disabled_at,
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
    void loadManualDuplicateIndexes();
  }, [isManager]);

  useFocusEffect(
    useCallback(() => {
      void loadDuplicateNameCounts();
      void loadManualDuplicateIndexes();
    }, [loadDuplicateNameCounts, loadManualDuplicateIndexes])
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
          loading ? null : (
            <EmptyState
              icon={q.trim().length > 0 ? "🔍" : "👥"}
              title={t("staffUsers.noUsers")}
              isRTL={isRTL}
            />
          )
        }
        renderItem={({ item }) => {
          const nameKey = normalizeParticipantName(item.full_name ?? "");
          const profileDuplicateName = item.kind === "profile" ? (duplicateNameCounts[nameKey] ?? 0) > 1 : false;
          const manualDuplicateName =
            item.kind === "manual" ? manualHasDuplicateName(item, manualDuplicateIndexes) : false;
          const manualDuplicatePhone =
            item.kind === "manual" ? manualHasDuplicatePhone(item, manualDuplicateIndexes) : false;
          const hasDuplicateHighlight = profileDuplicateName || manualDuplicateName || manualDuplicatePhone;
          const nameCount =
            item.kind === "profile" ? duplicateNameCounts[nameKey] ?? 0 : manualDuplicateIndexes.nameCounts[nameKey] ?? 0;
          const phoneCount =
            item.kind === "manual"
              ? manualDuplicateIndexes.phoneCounts[item.phone.replace(/\D/g, "")] ?? 0
              : 0;

          return (
            <Pressable
              onPress={() => {
                if (Platform.OS === "ios" || Platform.OS === "android") {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                if (item.kind === "profile") router.push(`/(app)/staff/profile/${item.user_id}` as never);
                else router.push(`/(app)/staff/manual/${item.id}` as never);
              }}
              accessibilityRole="button"
              accessibilityLabel={item.full_name}
              style={({ pressed }) => [
                styles.card,
                hasDuplicateHighlight && styles.cardDuplicateName,
                pressed && { opacity: 0.9 },
              ]}
            >
              <Text style={styles.name}>
                {item.full_name}
                {(() => {
                  const dob = (item as any).date_of_birth as string | null | undefined;
                  if (!dob || dob.length < 10) return null;
                  const md = dob.slice(5, 10);
                  const now = new Date();
                  const tmd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
                  return md === tmd ? (
                    <Text style={styles.bday} accessibilityLabel={t("staffUsers.birthdayToday")}>
                      {"  "}🎂
                    </Text>
                  ) : null;
                })()}
              </Text>
              {profileDuplicateName || manualDuplicateName ? (
                <Text style={[styles.duplicateBadge, isRTL && styles.rtlText]}>
                  {t("profile.duplicateNameBadge").replace("{n}", String(nameCount))}
                </Text>
              ) : null}
              {manualDuplicatePhone ? (
                <Text style={[styles.duplicateBadge, isRTL && styles.rtlText]}>
                  {t("manualParticipant.duplicatePhoneBadge").replace("{n}", String(phoneCount))}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                {item.kind === "profile"
                  ? `${t("profile.username")}: @${item.username} · ${item.phone} · ${item.role} · ${item.approval_status}${
                      item.disabled_at ? ` · ${t("profile.accountDisabledBadge")}` : ""
                    }`
                  : `${item.phone} · ${t("pricing.quickAddLabel")}${
                      item.disabled_at ? ` · ${t("profile.accountDisabledBadge")}` : ""
                    }`}
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
