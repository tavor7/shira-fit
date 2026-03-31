import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, TextInput, Modal, FlatList } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { useI18n } from "../../../../src/context/I18nContext";

type W = { user_id: string; profiles: { full_name: string } };
type CancellationRow = {
  user_id: string;
  cancelled_at: string;
  reason: string;
  charged_full_price: boolean;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

export default function CoachSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const [participantsRev, setParticipantsRev] = useState(0);
  const [waitlist, setWaitlist] = useState<W[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ user_id: string; full_name: string; username: string; phone: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");

  async function loadWaitlist() {
    const { data: w } = await supabase
      .from("waitlist_requests")
      .select("user_id, profiles(full_name)")
      .eq("session_id", id);
    setWaitlist((w as unknown as W[]) ?? []);
  }

  async function loadCancellations() {
    const { data, error } = await supabase
      .from("cancellations")
      .select("user_id, cancelled_at, reason, charged_full_price, profiles(full_name)")
      .eq("session_id", id)
      .order("cancelled_at", { ascending: false });
    if (error) {
      setCancellations([]);
      return;
    }
    setCancellations((data as unknown as CancellationRow[]) ?? []);
  }

  useEffect(() => {
    loadWaitlist();
    loadCancellations();
  }, [id]);

  async function searchAthletes() {
    const term = q.trim();
    setSearching(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(50);
    if (term.length > 0) {
      query = query.or(`full_name.ilike.%${term}%,username.ilike.%${term}%,phone.ilike.%${term}%`);
    }
    const { data, error } = await query;
    setSearching(false);
    if (error) {
      setResults([]);
      return;
    }
    setResults((data as any[]) ?? []);
  }

  async function addExistingAthlete(userId: string) {
    const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: id, p_user_id: userId });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נוסף" : "Added");
      setAddOpen(false);
      setQ("");
      setResults([]);
      loadWaitlist();
      loadCancellations();
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  async function quickAdd() {
    const name = quickName.trim();
    const phone = quickPhone.trim();
    if (name.length < 2 || phone.length < 3) {
      Alert.alert(language === "he" ? "חסר מידע" : "Missing info", language === "he" ? "הזינו שם וטלפון." : "Enter name and phone.");
      return;
    }
    const { data: up, error: upErr } = await supabase.rpc("upsert_manual_participant", {
      p_full_name: name,
      p_phone: phone,
    });
    if (upErr) {
      Alert.alert(t("common.error"), upErr.message);
      return;
    }
    const mid = up?.manual_participant_id as string | undefined;
    if (!mid) {
      Alert.alert(t("common.failed"), up?.error ?? (language === "he" ? "לא ניתן ליצור" : "Could not create"));
      return;
    }
    const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
      p_session_id: id,
      p_manual_participant_id: mid,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נוסף" : "Added");
      setQuickName("");
      setQuickPhone("");
      setAddOpen(false);
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "משתתפים ונוכחות" : "Participants & attendance"}</Text>
      <Text style={[styles.sub, isRTL && styles.rtlText]}>
        {language === "he"
          ? "סמנו מי הגיע לאחר האימון (או בכל זמן). מתאמנים עם הרשמה פעילה מופיעים כאן."
          : "Mark who arrived after the session (or anytime). Athletes with an active registration appear here."}
      </Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={() => {
          loadWaitlist();
          loadCancellations();
        }}
      />

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "רשימת המתנה" : "Waitlist"}</Text>
      {waitlist.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        waitlist.map((item) => (
          <Text key={item.user_id} style={styles.row}>
            {item.profiles?.full_name ?? item.user_id}
          </Text>
        ))
      )}
      <PrimaryButton
        label={language === "he" ? "הוספת משתתף" : "Add participant"}
        onPress={() => {
          setAddOpen(true);
          searchAthletes();
        }}
        variant="ghost"
      />

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
      <Text style={[styles.sub, isRTL && styles.rtlText]}>{language === "he" ? "גלוי רק למאמנים ולמנהלים." : "Visible to coaches and managers only."}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{new Date(c.cancelled_at).toLocaleString()}</Text>
              <Text style={styles.cancelReason}>{language === "he" ? "סיבה: " : "Reason: "}{c.reason}</Text>
              {c.charged_full_price ? (
                <Text style={styles.chargeWarn}>
                  {language === "he" ? "ביטול מאוחר (<24ש׳) — חיוב" : "Late cancellation (<24h) — charged"}
                </Text>
              ) : null}
            </View>
          );
        })
      )}
      <Modal visible={addOpen} transparent>
        <View style={styles.modal}>
          <View style={styles.modalCard}>
            <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{language === "he" ? "הוספת משתתף" : "Add participant"}</Text>
            <Text style={[styles.modalHint, isRTL && styles.rtlText]}>
              {language === "he"
                ? "חפשו מתאמנים קיימים, או הוספה מהירה לפי שם וטלפון (ללא חשבון)."
                : "Search existing athletes, or quick-add by name + phone (no account)."}
            </Text>

            <Text style={[styles.modalSub, isRTL && styles.rtlText]}>{language === "he" ? "חיפוש קיים" : "Search existing"}</Text>
            <View style={styles.searchRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                placeholder={language === "he" ? "חיפוש שם / טלפון / משתמש…" : "Search name / phone / username…"}
                placeholderTextColor={theme.colors.textSoft}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
              />
              <Pressable style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.9 }]} onPress={searchAthletes}>
                <Text style={styles.searchBtnTxt}>{searching ? "…" : t("common.search")}</Text>
              </Pressable>
            </View>
            <FlatList
              data={results}
              keyExtractor={(i) => i.user_id}
              style={{ maxHeight: 200, marginTop: 10 }}
              renderItem={({ item }) => (
                <Pressable style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.85 }]} onPress={() => addExistingAthlete(item.user_id)}>
                  <Text style={styles.pickName}>{item.full_name}</Text>
                  <Text style={styles.pickMeta}>@{item.username} · {item.phone}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={[styles.muted, isRTL && styles.rtlText]}>
                  {q.trim()
                    ? language === "he"
                      ? "אין התאמות."
                      : "No matches."
                    : language === "he"
                      ? "חפשו כדי לראות תוצאות."
                      : "Search to see results."}
                </Text>
              }
            />

            <Text style={[styles.modalSub, { marginTop: 14 }, isRTL && styles.rtlText]}>{language === "he" ? "הוספה מהירה (ללא חשבון)" : "Quick add (no account)"}</Text>
            <TextInput
              style={styles.input}
              placeholder={t("profile.fullName")}
              placeholderTextColor={theme.colors.textSoft}
              value={quickName}
              onChangeText={setQuickName}
            />
            <TextInput
              style={styles.input}
              placeholder={t("profile.phone")}
              placeholderTextColor={theme.colors.textSoft}
              value={quickPhone}
              onChangeText={setQuickPhone}
              keyboardType="phone-pad"
            />
            <PrimaryButton label={language === "he" ? "הוספה מהירה" : "Quick add"} onPress={quickAdd} />
            <Pressable onPress={() => setAddOpen(false)}>
              <Text style={styles.cancel}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
  sub: { fontSize: 13, color: theme.colors.textMuted, marginBottom: theme.spacing.sm, lineHeight: 18 },
  rtlText: { textAlign: "right" },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border, color: theme.colors.text },
  muted: { color: theme.colors.textSoft },
  cancelCard: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cancelName: { color: theme.colors.text, fontWeight: "800" },
  cancelMeta: { marginTop: 4, color: theme.colors.textMuted, fontSize: 12 },
  cancelReason: { marginTop: 6, color: theme.colors.text, lineHeight: 18 },
  chargeWarn: { marginTop: 8, color: theme.colors.error, fontWeight: "800" },
  modal: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  modalCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: 8 },
  modalHint: { color: theme.colors.textMuted, lineHeight: 18, marginBottom: 12, fontSize: 12 },
  modalSub: { fontWeight: "800", color: theme.colors.text, marginTop: 4, marginBottom: 8 },
  searchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  searchBtn: { paddingHorizontal: 12, height: 44, borderRadius: theme.radius.md, backgroundColor: theme.colors.cta, alignItems: "center", justifyContent: "center" },
  searchBtnTxt: { color: theme.colors.ctaText, fontWeight: "900" },
  pickRow: { paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.borderMuted },
  pickName: { color: theme.colors.text, fontWeight: "800" },
  pickMeta: { marginTop: 2, color: theme.colors.textMuted, fontSize: 12 },
  input: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    padding: 12,
    borderRadius: theme.radius.md,
    marginBottom: 12,
    fontSize: 16,
    color: theme.colors.text,
  },
  cancel: { marginTop: 12, color: theme.colors.textMuted, textAlign: "center", fontWeight: "600" },
});
