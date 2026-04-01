import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, FlatList, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";

type AthleteRow = { kind: "athlete"; id: string; title: string; subtitle: string };
type ManualRow = { kind: "manual"; id: string; title: string; subtitle: string };

export default function StaffSearchScreen() {
  const { language, t, isRTL } = useI18n();
  const { profile } = useAuth();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<(AthleteRow | ManualRow)[]>([]);

  const historyPath =
    profile?.role === "manager" ? "/(app)/manager/participant-history" : "/(app)/coach/participant-history";

  const runSearch = useCallback(async () => {
    const term = q.trim();
    setLoading(true);
    const next: (AthleteRow | ManualRow)[] = [];
    if (term.length >= 1) {
      const { data: athletes } = await supabase
        .from("profiles")
        .select("user_id, full_name, username, phone")
        .eq("role", "athlete")
        .or(`full_name.ilike.%${term}%,username.ilike.%${term}%,phone.ilike.%${term}%`)
        .order("full_name", { ascending: true })
        .limit(40);
      for (const a of athletes ?? []) {
        next.push({
          kind: "athlete",
          id: a.user_id,
          title: a.full_name ?? a.user_id,
          subtitle: `@${a.username ?? ""} · ${a.phone ?? ""}`,
        });
      }
      const { data: manuals } = await supabase
        .from("manual_participants")
        .select("id, full_name, phone")
        .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`)
        .order("full_name", { ascending: true })
        .limit(40);
      for (const m of manuals ?? []) {
        next.push({
          kind: "manual",
          id: m.id,
          title: m.full_name,
          subtitle: m.phone ?? "",
        });
      }
    }
    setRows(next);
    setLoading(false);
  }, [q]);

  return (
    <View style={styles.screen}>
      <Text style={[styles.h, isRTL && styles.rtl]}>{language === "he" ? "חיפוש מהיר" : "Staff search"}</Text>
      <View style={[styles.searchRow, isRTL && styles.searchRowRtl]}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder={language === "he" ? "שם / טלפון / משתמש…" : "Name / phone / username…"}
          placeholderTextColor={theme.colors.placeholderOnLight}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => void runSearch()}
          autoCapitalize="none"
        />
        <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.9 }]} onPress={() => void runSearch()}>
          <Text style={styles.btnTxt}>{t("common.search")}</Text>
        </Pressable>
      </View>

      {loading ? <ActivityIndicator color={theme.colors.cta} style={{ marginTop: 16 }} /> : null}

      <FlatList
        data={rows}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !loading ? (
            <Text style={[styles.empty, isRTL && styles.rtl]}>
              {q.trim().length < 1
                ? language === "he"
                  ? "הקלידו לפחות תו אחד."
                  : "Type at least one character."
                : language === "he"
                  ? "אין תוצאות."
                  : "No results."}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={[styles.card, surface.card]}>
            <Text style={[styles.name, isRTL && styles.rtl]}>{item.title}</Text>
            <Text style={[styles.sub, isRTL && styles.rtl]}>{item.subtitle}</Text>
            <View style={[styles.actions, isRTL && styles.actionsRtl]}>
              {item.kind === "athlete" ? (
                <>
                  <Pressable
                    style={styles.link}
                    onPress={() => router.push(`/(app)/staff/profile/${item.id}` as never)}
                  >
                    <Text style={styles.linkTxt}>{language === "he" ? "פרופיל" : "Profile"}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.link}
                    onPress={() => router.push(`${historyPath}?presetUserId=${encodeURIComponent(item.id)}` as never)}
                  >
                    <Text style={styles.linkTxt}>{t("menu.athleteActivity")}</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={styles.link} onPress={() => router.push(`/(app)/staff/manual/${item.id}` as never)}>
                  <Text style={styles.linkTxt}>{language === "he" ? "משתתף ידני" : "Manual"}</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
  h: { fontSize: 20, fontWeight: "900", color: theme.colors.text, marginBottom: 12 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  searchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  searchRowRtl: { flexDirection: "row-reverse" },
  input: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.textOnLight,
    fontSize: 16,
  },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  btnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  list: { paddingTop: 12, paddingBottom: 32, gap: 10 },
  card: { marginBottom: 4 },
  name: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  sub: { marginTop: 4, fontSize: 13, color: theme.colors.textMuted },
  actions: { flexDirection: "row", gap: 16, marginTop: 12 },
  actionsRtl: { flexDirection: "row-reverse" },
  link: { alignSelf: "flex-start" },
  linkTxt: { color: theme.colors.cta, fontWeight: "800", fontSize: 14 },
  empty: { marginTop: 24, color: theme.colors.textSoft, textAlign: "center" },
});
