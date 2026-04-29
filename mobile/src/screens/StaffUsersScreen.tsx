import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { ManagerOverviewTabs } from "../components/ManagerOverviewTabs";

type ProfileRow = {
  kind: "profile";
  user_id: string;
  full_name: string;
  username: string;
  phone: string;
  role: "athlete" | "coach" | "manager";
  approval_status: "pending" | "approved" | "rejected";
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
  const { language, t, isRTL } = useI18n();

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const qTrim = q.trim();

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone, role, approval_status, date_of_birth")
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
  }, [isManager, qTrim, t]);

  useEffect(() => {
    load();
  }, [load]);

  const subtitle = useMemo(() => {
    if (isManager) return language === "he" ? "חיפוש מתאמנים ומאמנים (מנהלים מוסתרים). לחצו על משתמש לעריכה." : "Search athletes and coaches (managers hidden). Tap a user to edit.";
    return language === "he" ? "חיפוש מתאמנים. לחצו על משתמש לעריכה." : "Search athletes. Tap a user to edit.";
  }, [isManager, language]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(i) => (i.kind === "profile" ? i.user_id : `manual:${i.id}`)}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.top}>
            {isManager ? <ManagerOverviewTabs /> : null}
            <Text style={[styles.title, isRTL && styles.rtlText]}>{language === "he" ? "משתמשים" : "Users"}</Text>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>{subtitle}</Text>
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={language === "he" ? "חיפוש שם / משתמש / טלפון…" : "Search name / username / phone…"}
              placeholderTextColor={theme.colors.placeholderOnLight}
              style={styles.input}
              autoCapitalize="none"
              onSubmitEditing={load}
            />
            <Pressable style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.9 }]} onPress={load}>
              <Text style={styles.searchBtnTxt}>
                {loading ? t("common.loading") : language === "he" ? "חיפוש" : "Search"}
              </Text>
            </Pressable>
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, isRTL && styles.rtlText]}>
            {loading ? t("common.loading") : language === "he" ? "לא נמצאו משתמשים." : "No users found."}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              if (item.kind === "profile") router.push(`/(app)/staff/profile/${item.user_id}` as never);
              else router.push(`/(app)/staff/manual/${item.id}` as never);
            }}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
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
            <Text style={styles.meta}>
              {item.kind === "profile"
                ? `@${item.username} · ${item.phone} · ${item.role} · ${item.approval_status}`
                : `${item.phone} · ${language === "he" ? "מהיר" : "Quick Add"}`}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  top: { padding: theme.spacing.md, borderBottomWidth: 1, borderBottomColor: theme.colors.borderMuted, marginBottom: theme.spacing.sm },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  hint: { marginTop: 6, color: theme.colors.textMuted, lineHeight: 18, fontSize: 12 },
  rtlText: { textAlign: "right" },
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
  bday: { color: theme.colors.cta, fontWeight: "900" },
  meta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
});

