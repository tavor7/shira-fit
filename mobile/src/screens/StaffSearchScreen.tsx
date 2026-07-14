import { useCallback, useState } from "react";
import { View, Pressable, StyleSheet, FlatList } from "react-native";
import { router } from "expo-router";
import { athleteSearchSubtitle } from "../lib/displayName";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { AppSearchField } from "../components/AppSearchField";
import { EmptyState } from "../components/EmptyState";
import { useSearchListBottomPadding } from "../hooks/useSearchListBottomPadding";
import { AppText } from "../components/AppText";
import { ListRowSkeleton } from "../components/ListRowSkeleton";

type AthleteRow = { kind: "athlete"; id: string; title: string; subtitle: string };
type ManualRow = { kind: "manual"; id: string; title: string; subtitle: string };

export default function StaffSearchScreen() {
  const { t, isRTL } = useI18n();
  const { profile } = useAuth();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<(AthleteRow | ManualRow)[]>([]);
  const listBottomPad = useSearchListBottomPadding();

  const historyPath =
    profile?.role === "manager" ? "/(app)/manager/participant-history" : "/(app)/coach/participant-history";

  const runSearch = useCallback(async (termRaw: string) => {
    const term = termRaw.trim();
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
          subtitle: athleteSearchSubtitle(a.phone),
        });
      }
      const { data: manuals } = await supabase
        .from("manual_participants")
        .select("id, full_name, phone")
        .is("disabled_at", null)
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
  }, []);

  const trimmedQ = q.trim();
  const showEmpty = !loading;

  return (
    <View style={styles.screen}>
      <AppText variant="headline" isRTL={isRTL} style={styles.h}>
        {t("staffSearch.title")}
      </AppText>
      <AppSearchField
        value={q}
        onChangeText={setQ}
        onSearch={(term) => void runSearch(term)}
        placeholder={t("staffSearch.placeholder")}
        isRTL={isRTL}
        loading={loading}
        style={styles.searchField}
      />

      {loading && rows.length === 0 ? (
        <View style={styles.list}>
          <ListRowSkeleton />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </View>
      ) : (
      <FlatList
        data={rows}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
        ListEmptyComponent={
          showEmpty ? (
            <EmptyState
              icon={trimmedQ.length < 1 ? "🔍" : "∅"}
              title={trimmedQ.length < 1 ? t("empty.typeAtLeastOne") : t("empty.noResults")}
              body={trimmedQ.length < 1 ? t("staffSearch.placeholder") : undefined}
              isRTL={isRTL}
              style={styles.empty}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <View style={[styles.card, surface.card]}>
            <AppText variant="title" isRTL={isRTL}>
              {item.title}
            </AppText>
            {item.subtitle ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.sub}>
                {item.subtitle}
              </AppText>
            ) : null}
            <View style={[styles.actions, isRTL && styles.actionsRtl]}>
              {item.kind === "athlete" ? (
                <>
                  <Pressable
                    style={({ pressed }) => [styles.link, pressed && { opacity: 0.7 }]}
                    onPress={() => router.push(`/(app)/staff/profile/${item.id}` as never)}
                  >
                    <AppText variant="caption" style={styles.linkTxt}>
                      {t("staffSearch.profileLink")}
                    </AppText>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.link, pressed && { opacity: 0.7 }]}
                    onPress={() => router.push(`${historyPath}?presetUserId=${encodeURIComponent(item.id)}` as never)}
                  >
                    <AppText variant="caption" style={styles.linkTxt}>
                      {t("menu.athleteActivity")}
                    </AppText>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.link, pressed && { opacity: 0.7 }]}
                  onPress={() => router.push(`/(app)/staff/manual/${item.id}` as never)}
                >
                  <AppText variant="caption" style={styles.linkTxt}>
                    {t("staffSearch.manualLink")}
                  </AppText>
                </Pressable>
              )}
            </View>
          </View>
        )}
      />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
  h: { marginBottom: theme.spacing.sm },
  searchField: { marginBottom: theme.spacing.sm },
  list: { paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  card: { marginBottom: theme.spacing.xs },
  sub: { marginTop: theme.spacing.xs },
  actions: { flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.sm },
  actionsRtl: { flexDirection: "row-reverse" },
  link: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  linkTxt: { color: theme.colors.cta, fontWeight: "800" },
  empty: { marginTop: theme.spacing.lg },
});
