import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { PrimaryButton } from "./PrimaryButton";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";

type Props = {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  /** After a successful add */
  onAdded: () => void;
};

/** Escape % and _ so ilike filters stay valid. */
function escapeIlike(term: string) {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function AddParticipantToSessionModal({ sessionId, visible, onClose, onAdded }: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /** Pixel cap so the card + ScrollView get a real bounded height on mobile web (flex + % maxHeight is flaky in Safari). */
  const modalMaxHeight = Math.min(Math.round(windowHeight * 0.92), windowHeight - Math.max(insets.top, 8) - 12);
  const scrollBottomPad = Math.max(insets.bottom, 12) + 28;
  /** Header, capacity line, and card vertical padding — scroll viewport = remaining space (explicit px scrolls reliably on iOS web). */
  const scrollViewportMax = Math.max(200, modalMaxHeight - 122);
  const [maxCap, setMaxCap] = useState<number | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ user_id: string; full_name: string; username: string; phone: string }[]>([]);
  const [manualResults, setManualResults] = useState<{ id: string; full_name: string; phone: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [adding, setAdding] = useState(false);

  const sid = typeof sessionId === "string" ? sessionId : Array.isArray(sessionId) ? sessionId[0] : String(sessionId ?? "");

  const loadCounts = useCallback(async () => {
    if (!sid) return;
    const { data: s } = await supabase.from("training_sessions").select("max_participants").eq("id", sid).single();
    setMaxCap((s as { max_participants?: number } | null)?.max_participants ?? null);
    const { count: c1 } = await supabase
      .from("session_registrations")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sid)
      .eq("status", "active");
    const { count: c2 } = await supabase
      .from("session_manual_participants")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sid);
    setCurrentCount((c1 ?? 0) + (c2 ?? 0));
  }, [sid]);

  const runSearch = useCallback(async (termRaw: string) => {
    const term = termRaw.trim();
    const safe = escapeIlike(term);
    setSearching(true);
    try {
      let pQuery = supabase
        .from("profiles")
        .select("user_id, full_name, username, phone")
        .eq("role", "athlete")
        .order("full_name", { ascending: true })
        .limit(50);
      if (term.length > 0) {
        pQuery = pQuery.or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%,phone.ilike.%${safe}%`);
      }
      const { data, error: pErr } = await pQuery;

      let mQuery = supabase.from("manual_participants").select("id, full_name, phone").order("full_name", { ascending: true }).limit(50);
      if (term.length > 0) {
        mQuery = mQuery.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
      }
      const { data: mData, error: mErr } = await mQuery;

      if (pErr) {
        setResults([]);
      } else {
        setResults((data as { user_id: string; full_name: string; username: string; phone: string }[]) ?? []);
      }
      if (mErr) {
        setManualResults([]);
      } else {
        setManualResults((mData as { id: string; full_name: string; phone: string }[]) ?? []);
      }
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setQ("");
    setQuickName("");
    setQuickPhone("");
    setAdding(false);
    void loadCounts();
    void runSearch("");
  }, [visible, sid, loadCounts, runSearch]);

  function isFull() {
    if (maxCap == null) return false;
    return currentCount >= maxCap;
  }

  const full = isFull();

  function toastSuccess(msg: string) {
    showToast({ message: msg, variant: "success" });
  }
  function toastError(title: string, detail?: string) {
    showToast({ message: title, detail, variant: "error" });
  }
  function toastInfo(title: string, detail?: string) {
    showToast({ message: title, detail, variant: "info" });
  }

  function rpcErrorMessage(code: string): string {
    if (code === "invalid_athlete") {
      return language === "he" ? "המתאמן חייב להיות מאושר במערכת." : "This person must be an approved athlete in the system.";
    }
    if (code === "forbidden") {
      return language === "he" ? "אין הרשאה." : "Not allowed.";
    }
    if (code === "session_ended") {
      return language === "he" ? "האימון כבר הסתיים." : "This session has already ended.";
    }
    if (code === "session_not_found") {
      return language === "he" ? "האימון לא נמצא." : "Session not found.";
    }
    return code;
  }

  async function addExistingAthlete(userId: string) {
    if (adding) return;
    if (!sid) {
      toastError(t("common.error"), language === "he" ? "חסר מזהה אימון." : "Missing session id.");
      return;
    }
    if (full) {
      toastInfo(language === "he" ? "האימון מלא" : "Session full");
      return;
    }
    setAdding(true);
    try {
      const { data: already, error: alreadyErr } = await supabase
        .from("session_registrations")
        .select("id")
        .eq("session_id", sid)
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();
      if (alreadyErr) {
        toastError(t("common.error"), alreadyErr.message);
        return;
      }
      if (already) {
        toastInfo(
          language === "he" ? "כבר רשום" : "Already registered",
          language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
        );
        return;
      }
      const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: sid, p_user_id: userId });
      if (error) {
        toastError(t("common.error"), error.message);
        return;
      }
      if (data?.ok) {
        toastSuccess(language === "he" ? "נוסף" : "Added");
        onClose();
        setQ("");
        setResults([]);
        await loadCounts();
        onAdded();
      } else {
        const errCode = String(data?.error ?? "");
        toastError(t("common.failed"), rpcErrorMessage(errCode) || errCode || t("common.failed"));
      }
    } catch (e) {
      toastError(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function addExistingManual(manualId: string) {
    if (adding) return;
    if (!sid) {
      toastError(t("common.error"), language === "he" ? "חסר מזהה אימון." : "Missing session id.");
      return;
    }
    if (full) {
      toastInfo(language === "he" ? "האימון מלא" : "Session full");
      return;
    }
    setAdding(true);
    try {
      const { data: already, error: alreadyErr } = await supabase
        .from("session_manual_participants")
        .select("id")
        .eq("session_id", sid)
        .eq("manual_participant_id", manualId)
        .maybeSingle();
      if (alreadyErr) {
        toastError(t("common.error"), alreadyErr.message);
        return;
      }
      if (already) {
        toastInfo(
          language === "he" ? "כבר רשום" : "Already registered",
          language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
        );
        return;
      }
      const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
        p_session_id: sid,
        p_manual_participant_id: manualId,
      });
      if (error) {
        toastError(t("common.error"), error.message);
        return;
      }
      if (data?.ok) {
        toastSuccess(language === "he" ? "נוסף" : "Added");
        onClose();
        await loadCounts();
        onAdded();
      } else {
        const e = String(data?.error ?? "");
        if (e === "already_in_session") {
          toastInfo(
            language === "he" ? "כבר רשום" : "Already registered",
            language === "he" ? "המשתתף כבר רשום לאימון." : "This participant is already registered for this session."
          );
        } else if (e === "full") {
          toastInfo(language === "he" ? "האימון מלא" : "Session full");
        } else {
          toastError(t("common.failed"), rpcErrorMessage(e) || e || t("common.failed"));
        }
      }
    } catch (err) {
      toastError(t("common.error"), err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function quickAdd() {
    const name = quickName.trim();
    const phone = quickPhone.trim();
    if (!sid) {
      toastError(t("common.error"), language === "he" ? "חסר מזהה אימון." : "Missing session id.");
      return;
    }
    if (name.length < 2 || phone.length < 3) {
      toastInfo(
        language === "he" ? "חסר מידע" : "Missing info",
        language === "he" ? "הזינו שם וטלפון." : "Enter name and phone."
      );
      return;
    }
    if (full) {
      toastInfo(language === "he" ? "האימון מלא" : "Session full");
      return;
    }
    if (adding) return;
    setAdding(true);
    try {
      const { data: up, error: upErr } = await supabase.rpc("upsert_manual_participant", {
        p_full_name: name,
        p_phone: phone,
      });
      if (upErr) {
        toastError(t("common.error"), upErr.message);
        return;
      }
      const mid = up?.manual_participant_id as string | undefined;
      if (!mid) {
        toastError(t("common.failed"), up?.error ?? (language === "he" ? "לא ניתן ליצור" : "Could not create"));
        return;
      }
      const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
        p_session_id: sid,
        p_manual_participant_id: mid,
      });
      if (error) {
        toastError(t("common.error"), error.message);
        return;
      }
      if (data?.ok) {
        toastSuccess(language === "he" ? "נוסף" : "Added");
        setQuickName("");
        setQuickPhone("");
        onClose();
        await loadCounts();
        onAdded();
      } else {
        toastError(t("common.failed"), String(data?.error ?? ""));
      }
    } catch (e) {
      toastError(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  function handleClose() {
    if (adding) return;
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalRoot}>
        <Pressable
          style={styles.backdrop}
          onPress={handleClose}
          accessibilityLabel={language === "he" ? "סגירה" : "Close"}
        />
        <View style={[styles.modalCard, isRTL && styles.modalCardRtl, { maxHeight: modalMaxHeight }]}>
          <View style={styles.modalTopFixed}>
            <View style={[styles.modalHeader, isRTL && styles.modalHeaderRtl]}>
              <Text style={[styles.modalTitle, isRTL && styles.rtlText]} numberOfLines={2}>
                {language === "he" ? "הוספת משתתף" : "Add participant"}
              </Text>
              <Pressable
                onPress={handleClose}
                hitSlop={12}
                style={({ pressed }) => [styles.closeX, pressed && { opacity: 0.75 }]}
                accessibilityRole="button"
                accessibilityLabel={language === "he" ? "סגירה" : "Close"}
              >
                <Text style={styles.closeXText}>✕</Text>
              </Pressable>
            </View>

            <Text style={[styles.capacityLine, isRTL && styles.rtlText]}>
              {language === "he" ? "קיבולת: " : "Capacity: "}
              {currentCount}
              {maxCap != null ? `/${maxCap}` : ""}
              {full ? (language === "he" ? " · מלא" : " · Full") : ""}
            </Text>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="always"
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={styles.scrollBody}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomPad }]}
            bounces
          >
            <Text style={[styles.modalSub, isRTL && styles.rtlText]}>{language === "he" ? "חיפוש קיים" : "Search existing"}</Text>
            <View style={[styles.searchRow, isRTL && styles.searchRowRtl]}>
              <TextInput
                style={[styles.input, styles.inputFlex, isRTL && styles.inputRtl]}
                placeholder={language === "he" ? "חיפוש שם / טלפון / משתמש…" : "Search name / phone / username…"}
                placeholderTextColor={theme.colors.textSoft}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                editable={!adding}
              />
              <Pressable
                style={({ pressed }) => [styles.searchBtn, pressed && { opacity: 0.9 }, adding && { opacity: 0.5 }]}
                onPress={() => void runSearch(q)}
                disabled={adding}
              >
                <Text style={styles.searchBtnTxt}>{searching ? "…" : t("common.search")}</Text>
              </Pressable>
            </View>

            <View style={styles.listSection}>
              {results.length === 0 ? (
                <Text style={[styles.muted, isRTL && styles.rtlText]}>
                  {q.trim()
                    ? language === "he"
                      ? "אין התאמות באתלטים."
                      : "No matching athletes."
                    : language === "he"
                      ? "מוצגים עד 50 מתאמנים — חפשו לצמצום."
                      : "Showing up to 50 athletes — search to narrow."}
                </Text>
              ) : (
                results.map((item) => (
                  <TouchableOpacity
                    key={item.user_id}
                    activeOpacity={0.85}
                    delayPressIn={0}
                    disabled={full || adding}
                    style={[styles.pickRow, full && styles.pickRowDisabled, Platform.OS === "web" && styles.pickRowWeb]}
                    onPress={() => void addExistingAthlete(item.user_id)}
                  >
                    <Text style={[styles.pickName, isRTL && styles.rtlText]}>{item.full_name}</Text>
                    <Text style={[styles.pickMeta, isRTL && styles.rtlText]}>
                      @{item.username} · {item.phone}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </View>

            <Text style={[styles.modalSub, styles.modalSubSpaced, isRTL && styles.rtlText]}>
              {language === "he" ? "משתתפים ידניים (ללא חשבון)" : "Manual participants (no account)"}
            </Text>
            <View style={styles.listSection}>
              {manualResults.length === 0 ? (
                <Text style={[styles.muted, isRTL && styles.rtlText]}>
                  {q.trim()
                    ? language === "he"
                      ? "אין התאמות ברשימה הידנית."
                      : "No matching manual participants."
                    : language === "he"
                      ? "מוצגים עד 50 רשומות — חפשו לצמצום."
                      : "Showing up to 50 entries — search to narrow."}
                </Text>
              ) : (
                manualResults.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    activeOpacity={0.85}
                    delayPressIn={0}
                    disabled={full || adding}
                    style={[styles.pickRow, full && styles.pickRowDisabled, Platform.OS === "web" && styles.pickRowWeb]}
                    onPress={() => void addExistingManual(item.id)}
                  >
                    <Text style={[styles.pickName, isRTL && styles.rtlText]}>{item.full_name}</Text>
                    <Text style={[styles.pickMeta, isRTL && styles.rtlText]}>{item.phone}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>

            <Text style={[styles.modalSub, styles.modalSubSpaced, isRTL && styles.rtlText]}>
              {language === "he" ? "הוספה מהירה (ללא חשבון)" : "Quick add (no account)"}
            </Text>
            <TextInput
              style={[styles.input, isRTL && styles.inputRtl]}
              placeholder={t("profile.fullName")}
              placeholderTextColor={theme.colors.textSoft}
              value={quickName}
              onChangeText={setQuickName}
              editable={!adding}
            />
            <TextInput
              style={[styles.input, isRTL && styles.inputRtl]}
              placeholder={t("profile.phone")}
              placeholderTextColor={theme.colors.textSoft}
              value={quickPhone}
              onChangeText={setQuickPhone}
              keyboardType="phone-pad"
              editable={!adding}
            />
            <PrimaryButton
              label={language === "he" ? "הוספה מהירה" : "Quick add"}
              onPress={() => void quickAdd()}
              disabled={full || adding}
              loading={adding}
              loadingLabel={t("common.loading")}
              style={full ? { opacity: 0.5 } : undefined}
            />
            <Pressable onPress={handleClose} disabled={adding} style={({ pressed }) => [pressed && { opacity: 0.8 }]}>
              <Text style={[styles.cancel, isRTL && styles.rtlText]}>{t("common.cancel")}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right" },
  muted: { color: theme.colors.textSoft },
  modalRoot: { flex: 1, justifyContent: "center", padding: 24, position: "relative" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 0,
  },
  modalCard: {
    position: "relative",
    zIndex: 100,
    elevation: 24,
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  /** Header + capacity stay visible; ScrollView below takes remaining height and scrolls. */
  modalTopFixed: { flexShrink: 0 },
  modalCardRtl: {},
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  },
  modalHeaderRtl: { flexDirection: "row-reverse" },
  modalTitle: { flex: 1, fontSize: 18, fontWeight: "800", color: theme.colors.text },
  closeX: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  closeXText: { fontSize: 18, fontWeight: "700", color: theme.colors.textMuted, lineHeight: 20 },
  capacityLine: { color: theme.colors.textMuted, fontWeight: "800", marginBottom: 8 },
  /** flex:1 + minHeight:0 is required for ScrollView to scroll inside a capped-height parent (iOS Safari / RN Web). */
  scrollBody: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    ...(Platform.OS === "web" ? { overflowY: "scroll" as const } : {}),
  },
  scrollContent: { flexGrow: 1 },
  modalSub: { fontWeight: "800", color: theme.colors.text, marginTop: 4, marginBottom: 8 },
  modalSubSpaced: { marginTop: 14 },
  searchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  searchRowRtl: { flexDirection: "row-reverse" },
  searchBtn: { paddingHorizontal: 12, height: 44, borderRadius: theme.radius.md, backgroundColor: theme.colors.cta, alignItems: "center", justifyContent: "center" },
  searchBtnTxt: { color: theme.colors.ctaText, fontWeight: "900" },
  listSection: { marginBottom: 4 },
  pickRow: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    marginBottom: 8,
    backgroundColor: theme.colors.surface,
  },
  /** Web: pointer cursor + hit target (RN Web ScrollView + Pressable is flaky). */
  pickRowWeb: { cursor: "pointer" } as const,
  pickRowDisabled: { opacity: 0.5 },
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
  inputFlex: { flex: 1, marginBottom: 0, minWidth: 0 },
  inputRtl: { textAlign: "right" },
  cancel: { marginTop: 12, color: theme.colors.textMuted, textAlign: "center", fontWeight: "600", paddingVertical: 8 },
});
