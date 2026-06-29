import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, View, Text, Pressable, StyleSheet, ScrollView, Platform } from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { AppSearchSheet } from "./AppSearchSheet";
import { ParticipantQuickAddPanel } from "./ParticipantQuickAddPanel";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { findExistingParticipantByNameOrPhone } from "../lib/findExistingParticipant";
import { promptAddExistingParticipant } from "../lib/promptExistingParticipant";
import { athleteSearchSubtitle } from "../lib/displayName";

type Props = {
  sessionId: string;
  visible: boolean;
  onClose: () => void;
  /** After a successful add */
  onAdded: () => void;
};

type FullAddChoice = "cancel" | "increase" | "over";

type WebFullAddPrompt =
  | null
  | { kind: "athlete"; userId: string }
  | { kind: "manual"; manualId: string }
  | { kind: "quick" };

/** Escape % and _ so ilike filters stay valid. */
function escapeIlike(term: string) {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Always pass p_allow_over_capacity so PostgREST matches the single 3-arg DB function. */
function coachAddAthleteRpcArgs(sid: string, userId: string, allowOverCapacity: boolean) {
  return {
    p_session_id: sid,
    p_user_id: userId,
    p_allow_over_capacity: allowOverCapacity,
  };
}

function addManualParticipantRpcArgs(sid: string, manualId: string, allowOverCapacity: boolean) {
  return {
    p_session_id: sid,
    p_manual_participant_id: manualId,
    p_allow_over_capacity: allowOverCapacity,
  };
}

export function AddParticipantToSessionModal({ sessionId, visible, onClose, onAdded }: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showAlert } = useAppAlert();
  const [maxCap, setMaxCap] = useState<number | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ user_id: string; full_name: string; username: string; phone: string }[]>([]);
  const [manualResults, setManualResults] = useState<{ id: string; full_name: string; phone: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [adding, setAdding] = useState(false);
  /** Web: `window.confirm` is unreliable inside RN Modal — use inline banner instead. */
  const [webFullAddPrompt, setWebFullAddPrompt] = useState<WebFullAddPrompt>(null);

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

  const fullAddCopy = useMemo(
    () => ({
      title: language === "he" ? "האימון מלא" : "Session full",
      message:
        language === "he"
          ? "האימון הגיע למקסימום. איך להוסיף את המשתתף?"
          : "This session is at capacity. How would you like to add this participant?",
      increase: language === "he" ? "להגדיל את הקיבולת" : "Increase capacity",
      over: language === "he" ? "לשמור על הקיבולת ולהוסיף" : "Keep capacity, add anyway",
      cancel: language === "he" ? "ביטול" : "Cancel",
    }),
    [language]
  );

  const promptFullAddChoiceNative = useCallback(async (): Promise<FullAddChoice> => {
    return await new Promise<FullAddChoice>((resolve) => {
      Alert.alert(fullAddCopy.title, fullAddCopy.message, [
        { text: fullAddCopy.cancel, style: "cancel", onPress: () => resolve("cancel") },
        { text: fullAddCopy.over, onPress: () => resolve("over") },
        { text: fullAddCopy.increase, onPress: () => resolve("increase") },
      ]);
    });
  }, [fullAddCopy]);

  async function increaseSessionCapacity(): Promise<boolean> {
    if (!sid) return false;
    const base = maxCap != null ? Math.max(maxCap, currentCount) : currentCount;
    const newMax = base + 1;
    const { error } = await supabase.from("training_sessions").update({ max_participants: newMax }).eq("id", sid);
    if (error) {
      toastError(t("common.error"), error.message);
      return false;
    }
    setMaxCap(newMax);
    return true;
  }

  async function executePendingFullAdd(prompt: NonNullable<WebFullAddPrompt>, choice: FullAddChoice) {
    if (choice === "cancel") return;
    const allowOver = choice === "over";
    if (choice === "increase") {
      if (!(await increaseSessionCapacity())) return;
    }
    if (prompt.kind === "athlete") await runAddExistingAthleteCore(prompt.userId, allowOver);
    else if (prompt.kind === "manual") await runAddExistingManualCore(prompt.manualId, allowOver);
    else await runQuickAddCore(allowOver);
  }

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

      let mQuery = supabase.from("manual_participants").select("id, full_name, phone").is("disabled_at", null).order("full_name", { ascending: true }).limit(50);
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
    setWebFullAddPrompt(null);
    void loadCounts();
  }, [visible, sid, loadCounts]);

  const combinedPicks = useMemo(() => {
    type Row =
      | { kind: "athlete"; key: string; full_name: string; meta: string; user_id: string }
      | { kind: "manual"; key: string; full_name: string; meta: string; manual_id: string };
    const rows: Row[] = [
      ...manualResults.map((m) => ({
        kind: "manual" as const,
        key: `m:${m.id}`,
        full_name: m.full_name,
        meta: m.phone,
        manual_id: m.id,
      })),
      ...results.map((a) => ({
        kind: "athlete" as const,
        key: `a:${a.user_id}`,
        full_name: a.full_name,
        meta: athleteSearchSubtitle(a.phone),
        user_id: a.user_id,
      })),
    ];
    rows.sort((a, b) => a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" }));
    return rows;
  }, [results, manualResults]);

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
    if (code === "account_disabled") {
      return t("profile.accountDisabledStaffHint");
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

  async function runAddExistingAthleteCore(userId: string, allowOverCapacity = false) {
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
      const { data, error } = await supabase.rpc("coach_add_athlete", coachAddAthleteRpcArgs(sid, userId, allowOverCapacity));
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

  async function runAddExistingManualCore(manualId: string, allowOverCapacity = false) {
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
      const { data, error } = await supabase.rpc(
        "add_manual_participant_to_session",
        addManualParticipantRpcArgs(sid, manualId, allowOverCapacity)
      );
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

  async function addExistingFromMatch(match: Awaited<ReturnType<typeof findExistingParticipantByNameOrPhone>>) {
    if (!match) return;
    setQuickName("");
    setQuickPhone("");
    if (match.kind === "app") {
      if (full) await resolveFullAdd({ kind: "athlete", userId: match.id });
      else await runAddExistingAthleteCore(match.id, false);
    } else {
      if (full) await resolveFullAdd({ kind: "manual", manualId: match.id });
      else await runAddExistingManualCore(match.id, false);
    }
  }

  async function runQuickAddCore(allowOverCapacity = false) {
    const name = quickName.trim();
    const phone = quickPhone.trim();
    const existing = await findExistingParticipantByNameOrPhone(name, phone);
    if (existing) {
      const add = await promptAddExistingParticipant(showAlert, t, existing);
      if (!add) return;
      await addExistingFromMatch(existing);
      return;
    }
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
      const { data, error } = await supabase.rpc(
        "add_manual_participant_to_session",
        addManualParticipantRpcArgs(sid, mid, allowOverCapacity)
      );
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

  async function confirmWebFullAddChoice(choice: FullAddChoice) {
    if (!webFullAddPrompt) return;
    const p = webFullAddPrompt;
    setWebFullAddPrompt(null);
    await executePendingFullAdd(p, choice);
  }

  async function resolveFullAdd(prompt: NonNullable<WebFullAddPrompt>): Promise<void> {
    if (Platform.OS === "web") {
      setWebFullAddPrompt(prompt);
      return;
    }
    const choice = await promptFullAddChoiceNative();
    await executePendingFullAdd(prompt, choice);
  }

  async function addExistingAthlete(userId: string) {
    if (adding) return;
    if (!sid) {
      toastError(t("common.error"), language === "he" ? "חסר מזהה אימון." : "Missing session id.");
      return;
    }
    if (full) {
      await resolveFullAdd({ kind: "athlete", userId });
      return;
    }
    await runAddExistingAthleteCore(userId, false);
  }

  async function addExistingManual(manualId: string) {
    if (adding) return;
    if (!sid) {
      toastError(t("common.error"), language === "he" ? "חסר מזהה אימון." : "Missing session id.");
      return;
    }
    if (full) {
      await resolveFullAdd({ kind: "manual", manualId });
      return;
    }
    await runAddExistingManualCore(manualId, false);
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
    if (adding) return;

    const existing = await findExistingParticipantByNameOrPhone(name, phone);
    if (existing) {
      const add = await promptAddExistingParticipant(showAlert, t, existing);
      if (!add) return;
      await addExistingFromMatch(existing);
      return;
    }

    if (full) {
      await resolveFullAdd({ kind: "quick" });
      return;
    }
    await runQuickAddCore(false);
  }

  function handleClose() {
    if (adding) return;
    setWebFullAddPrompt(null);
    onClose();
  }

  const addTitle = language === "he" ? "הוספת משתתף" : "Add participant";
  const capacityLabel = `${language === "he" ? "קיבולת" : "Capacity"}: ${currentCount}${
    maxCap != null ? `/${maxCap}` : ""
  }${full ? (language === "he" ? " · מלא" : " · Full") : ""}`;

  return (
    <AppSearchSheet
      visible={visible}
      onClose={handleClose}
      title={addTitle}
      subtitle={capacityLabel}
      dismissLabel={language === "he" ? "סגירה" : "Close"}
      isRTL={isRTL}
      backdropAccessibilityLabel={language === "he" ? "סגירה" : "Close"}
      sheetHeightPct={0.9}
      headerExtra={
        <>
          {webFullAddPrompt ? (
            <View style={[styles.capBanner, isRTL && styles.capBannerRtl]} accessibilityLiveRegion="polite">
              <Text style={[styles.capBannerTitle, isRTL && styles.rtlText]}>{fullAddCopy.title}</Text>
              <Text style={[styles.capBannerTxt, isRTL && styles.rtlText]}>{fullAddCopy.message}</Text>
              <Pressable
                style={({ pressed }) => [styles.capBtnCta, pressed && { opacity: 0.9 }]}
                onPress={() => void confirmWebFullAddChoice("increase")}
                disabled={adding}
                accessibilityRole="button"
              >
                <Text style={styles.capBtnCtaTxt}>{fullAddCopy.increase}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.capBtnSecondary, pressed && { opacity: 0.9 }]}
                onPress={() => void confirmWebFullAddChoice("over")}
                disabled={adding}
                accessibilityRole="button"
              >
                <Text style={styles.capBtnSecondaryTxt}>{fullAddCopy.over}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.capBtnGhost, pressed && { opacity: 0.88 }]}
                onPress={() => setWebFullAddPrompt(null)}
                disabled={adding}
                accessibilityRole="button"
              >
                <Text style={styles.capBtnGhostTxt}>{fullAddCopy.cancel}</Text>
              </Pressable>
            </View>
          ) : null}
          <ParticipantQuickAddPanel
            name={quickName}
            phone={quickPhone}
            onNameChange={setQuickName}
            onPhoneChange={setQuickPhone}
            onSubmit={() => void quickAdd()}
            busy={adding}
            disabled={adding}
          />
        </>
      }
      searchConfig={{
        value: q,
        onChangeText: setQ,
        onSearch: (term) => void runSearch(term),
        placeholder: language === "he" ? "חיפוש שם / טלפון / משתמש…" : "Search name / phone / username…",
        loading: searching,
        editable: !adding,
      }}
      results={
        <ScrollView
          style={styles.resultsScroll}
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator
          nestedScrollEnabled
        >
          {combinedPicks.length === 0 ? (
            <Text style={[styles.muted, isRTL && styles.rtlText]}>
              {q.trim()
                ? language === "he"
                  ? "אין התאמות."
                  : "No matches."
                : language === "he"
                  ? "מוצגים עד 50 — חפשו לצמצום."
                  : "Showing up to 50 — search to narrow."}
            </Text>
          ) : (
            combinedPicks.map((item) => (
              <Pressable
                key={item.key}
                disabled={adding}
                style={({ pressed }) => [
                  styles.pickRow,
                  Platform.OS === "web" && styles.pickRowWeb,
                  pressed && !adding && { opacity: 0.88 },
                ]}
                onPress={() =>
                  void (item.kind === "athlete"
                    ? addExistingAthlete(item.user_id)
                    : addExistingManual(item.manual_id))
                }
                accessibilityRole="button"
              >
                <Text style={[styles.pickName, isRTL && styles.rtlText]}>{item.full_name}</Text>
                <Text style={[styles.pickMeta, isRTL && styles.rtlText]}>{item.meta}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      }
    />
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right", writingDirection: "rtl" },
  muted: { color: theme.colors.textSoft, paddingVertical: theme.spacing.sm, textAlign: "center", fontWeight: "600" },
  capBanner: {
    padding: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.surface,
    gap: 8,
  },
  capBannerRtl: { alignItems: "stretch" },
  capBannerTitle: { color: theme.colors.text, fontWeight: "800", fontSize: 15 },
  capBannerTxt: { color: theme.colors.textMuted, fontWeight: "600", fontSize: 13, lineHeight: 18 },
  capBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
  },
  capBtnSecondaryTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  capBtnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minWidth: 72,
    alignItems: "center",
  },
  capBtnGhostTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  capBtnCta: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    minWidth: 120,
    alignItems: "center",
  },
  capBtnCtaTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 14 },
  resultsScroll: { flex: 1 },
  resultsContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
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
});
