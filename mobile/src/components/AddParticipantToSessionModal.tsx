import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Modal, FlatList, Alert } from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { PrimaryButton } from "./PrimaryButton";
import { useI18n } from "../context/I18nContext";

type Props = {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  /** After a successful add */
  onAdded: () => void;
};

export function AddParticipantToSessionModal({ sessionId, visible, onClose, onAdded }: Props) {
  const { language, t, isRTL } = useI18n();
  const [maxCap, setMaxCap] = useState<number | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ user_id: string; full_name: string; username: string; phone: string }[]>([]);
  const [manualResults, setManualResults] = useState<{ id: string; full_name: string; phone: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");

  const loadCounts = useCallback(async () => {
    const { data: s } = await supabase.from("training_sessions").select("max_participants").eq("id", sessionId).single();
    setMaxCap((s as { max_participants?: number } | null)?.max_participants ?? null);
    const { count: c1 } = await supabase
      .from("session_registrations")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "active");
    const { count: c2 } = await supabase
      .from("session_manual_participants")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId);
    setCurrentCount((c1 ?? 0) + (c2 ?? 0));
  }, [sessionId]);

  const runSearch = useCallback(async (termRaw: string) => {
    const term = termRaw.trim();
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
    const { data: mData } = await supabase
      .from("manual_participants")
      .select("id, full_name, phone")
      .order("full_name", { ascending: true })
      .limit(50)
      .or(term.length > 0 ? `full_name.ilike.%${term}%,phone.ilike.%${term}%` : "full_name.ilike.%");
    setSearching(false);
    if (error) {
      setResults([]);
      setManualResults([]);
      return;
    }
    setResults((data as { user_id: string; full_name: string; username: string; phone: string }[]) ?? []);
    setManualResults((mData as { id: string; full_name: string; phone: string }[]) ?? []);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setQ("");
    setQuickName("");
    setQuickPhone("");
    void loadCounts();
    void runSearch("");
  }, [visible, sessionId, loadCounts, runSearch]);

  function isFull() {
    if (maxCap == null) return false;
    return currentCount >= maxCap;
  }

  async function addExistingAthlete(userId: string) {
    if (isFull()) {
      Alert.alert(language === "he" ? "האימון מלא" : "Session full");
      return;
    }
    const { data: already } = await supabase
      .from("session_registrations")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (already) {
      Alert.alert(
        language === "he" ? "כבר רשום" : "Already registered",
        language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
      );
      return;
    }
    const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: sessionId, p_user_id: userId });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נוסף" : "Added");
      onClose();
      setQ("");
      setResults([]);
      await loadCounts();
      onAdded();
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  async function addExistingManual(manualId: string) {
    if (isFull()) {
      Alert.alert(language === "he" ? "האימון מלא" : "Session full");
      return;
    }
    const { data: already } = await supabase
      .from("session_manual_participants")
      .select("id")
      .eq("session_id", sessionId)
      .eq("manual_participant_id", manualId)
      .maybeSingle();
    if (already) {
      Alert.alert(
        language === "he" ? "כבר רשום" : "Already registered",
        language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
      );
      return;
    }
    const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
      p_session_id: sessionId,
      p_manual_participant_id: manualId,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נוסף" : "Added");
      onClose();
      await loadCounts();
      onAdded();
    } else {
      const e = String(data?.error ?? "");
      if (e === "already_in_session") {
        Alert.alert(
          language === "he" ? "כבר רשום" : "Already registered",
          language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
        );
      } else if (e === "full") {
        Alert.alert(language === "he" ? "האימון מלא" : "Session full");
      } else {
        Alert.alert(t("common.failed"), data?.error ?? "");
      }
    }
  }

  async function quickAdd() {
    const name = quickName.trim();
    const phone = quickPhone.trim();
    if (name.length < 2 || phone.length < 3) {
      Alert.alert(language === "he" ? "חסר מידע" : "Missing info", language === "he" ? "הזינו שם וטלפון." : "Enter name and phone.");
      return;
    }
    if (isFull()) {
      Alert.alert(language === "he" ? "האימון מלא" : "Session full");
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
      p_session_id: sessionId,
      p_manual_participant_id: mid,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נוסף" : "Added");
      setQuickName("");
      setQuickPhone("");
      onClose();
      await loadCounts();
      onAdded();
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modal}>
        <View style={styles.modalCard}>
          <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{language === "he" ? "הוספת משתתף" : "Add participant"}</Text>

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
            <Pressable style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.9 }]} onPress={() => void runSearch(q)}>
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
                <Text style={styles.pickMeta}>
                  @{item.username} · {item.phone}
                </Text>
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

          <Text style={[styles.modalSub, { marginTop: 14 }, isRTL && styles.rtlText]}>
            {language === "he" ? "חיפוש משתתף שנוסף ידנית" : "Search quick-added participant"}
          </Text>
          <FlatList
            data={manualResults}
            keyExtractor={(i) => i.id}
            style={{ maxHeight: 160, marginTop: 10 }}
            renderItem={({ item }) => (
              <Pressable style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.85 }]} onPress={() => addExistingManual(item.id)}>
                <Text style={styles.pickName}>{item.full_name}</Text>
                <Text style={styles.pickMeta}>{item.phone}</Text>
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

          <Text style={[styles.modalSub, { marginTop: 14 }, isRTL && styles.rtlText]}>
            {language === "he" ? "הוספה מהירה (ללא חשבון)" : "Quick add (no account)"}
          </Text>
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
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right" },
  muted: { color: theme.colors.textSoft },
  modal: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  modalCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: 8 },
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
