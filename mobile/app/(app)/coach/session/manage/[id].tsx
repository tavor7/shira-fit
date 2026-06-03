import { useLocalSearchParams, router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator, ScrollView, Modal, Platform } from "react-native";
import { supabase } from "../../../../../src/lib/supabase";
import type { TrainingSession } from "../../../../../src/types/database";
import { theme } from "../../../../../src/theme";
import { PrimaryButton } from "../../../../../src/components/PrimaryButton";
import { SessionWhenFields } from "../../../../../src/components/SessionWhenFields";
import { SessionCapacityFields } from "../../../../../src/components/SessionCapacityFields";
import {
  clampSessionDuration,
  clampSessionMaxParticipants,
  isValidSessionDuration,
  isValidSessionMaxParticipants,
  normalizeSessionDurationString,
  normalizeSessionMaxString,
} from "../../../../../src/lib/sessionCapacityOptions";
import { isMissingColumnError } from "../../../../../src/lib/dbColumnErrors";
import { isValidISODateString, toISODateLocal } from "../../../../../src/lib/isoDate";
import { useI18n } from "../../../../../src/context/I18nContext";
import { sessionFormStyles as sf } from "../../../../../src/components/sessionFormStyles";
import { useToast } from "../../../../../src/context/ToastContext";
import { copySessionParticipantsToNewSession } from "../../../../../src/lib/copySessionParticipants";
import { SessionSlotRateField } from "../../../../../src/components/SessionSlotRateField";
import { SessionOptionsSection } from "../../../../../src/components/SessionOptionsSection";
import {
  SessionCoachPickerField,
  formatCoachOptionLabel,
  type CoachOption,
} from "../../../../../src/components/SessionCoachPickerField";
import {
  fetchActiveGlobalTierPrice,
  parseCustomSlotPriceDraft,
} from "../../../../../src/lib/sessionSlotPrice";
import {
  formatSessionSeriesError,
  isMissingSessionSeriesRpc,
  updateSessionWithSeriesScope,
  type SeriesScope,
} from "../../../../../src/lib/sessionSeries";
import {
  SessionSeriesScopeSheet,
  type SeriesScopeChoice,
} from "../../../../../src/components/SessionSeriesScopeSheet";

type EditSnapshot = {
  date: string;
  time: string;
  maxP: string;
  durationMin: string;
  open: boolean;
  hidden: boolean;
  isKickbox: boolean;
};

export default function CoachSessionManageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [maxP, setMaxP] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [isKickbox, setIsKickbox] = useState(false);
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([]);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupDate, setDupDate] = useState("");
  const [dupTime, setDupTime] = useState("");
  const [dupBusy, setDupBusy] = useState(false);
  const [dupIncludeParticipants, setDupIncludeParticipants] = useState(false);
  const [dupCoachId, setDupCoachId] = useState("");
  const [dupCoachLabel, setDupCoachLabel] = useState("");
  const [customSlotPriceDraft, setCustomSlotPriceDraft] = useState("");
  const [tierSlotPriceIls, setTierSlotPriceIls] = useState<number | null>(null);
  const [seriesScopeOpen, setSeriesScopeOpen] = useState(false);

  function pushUndo() {
    setUndoStack((prev) => {
      const snap: EditSnapshot = { date, time, maxP, durationMin, open, hidden, isKickbox };
      const head = prev[prev.length - 1];
      if (
        head &&
        head.date === snap.date &&
        head.time === snap.time &&
        head.maxP === snap.maxP &&
        head.durationMin === snap.durationMin &&
        head.open === snap.open &&
        head.hidden === snap.hidden &&
        head.isKickbox === snap.isKickbox
      ) {
        return prev;
      }
      if (prev.length >= 30) return [...prev.slice(prev.length - 29), snap];
      return [...prev, snap];
    });
  }

  function undoLast() {
    setUndoStack((prev) => {
      const snap = prev[prev.length - 1];
      if (!snap) return prev;
      setDate(snap.date);
      setTime(snap.time);
      setMaxP(snap.maxP);
      setDurationMin(snap.durationMin);
      setOpen(snap.open);
      setHidden(snap.hidden);
      setIsKickbox(snap.isKickbox);
      return prev.slice(0, -1);
    });
  }

  useEffect(() => {
    (async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      const { data: s } = await supabase.from("training_sessions").select("*").eq("id", id).single();
      if (!s) {
        setSession(null);
        setForbidden(false);
        setReady(true);
        return;
      }
      if (!uid || s.coach_id !== uid) {
        setForbidden(true);
        setSession(s as TrainingSession);
        setReady(true);
        return;
      }
      setSession(s as TrainingSession);
      setDate(s.session_date);
      setTime(s.start_time);
      setMaxP(normalizeSessionMaxString(String(s.max_participants)));
      setDurationMin(normalizeSessionDurationString(String(s.duration_minutes ?? 60)));
      setOpen(s.is_open_for_registration);
      setHidden(!!(s as { is_hidden?: boolean }).is_hidden);
      setIsKickbox(!!(s as TrainingSession).is_kickbox);
      const customRaw = (s as TrainingSession).custom_slot_price_ils;
      const customNum = customRaw != null && Number.isFinite(Number(customRaw)) ? Number(customRaw) : null;
      setCustomSlotPriceDraft(customNum != null ? String(customNum) : "");
      const tierP = await fetchActiveGlobalTierPrice(supabase, s.max_participants, {
        isKickbox: !!(s as TrainingSession).is_kickbox,
        asOf: s.session_date,
      });
      setTierSlotPriceIls(tierP);
      setUndoStack([]);
      setForbidden(false);
      setReady(true);
    })();
  }, [id]);

  useEffect(() => {
    const cap = parseInt(maxP, 10);
    if (!Number.isFinite(cap) || cap < 1) return;
    let cancelled = false;
    const asOf = isValidISODateString(date.trim()) ? date.trim() : toISODateLocal(new Date());
    void (async () => {
      const tierP = await fetchActiveGlobalTierPrice(supabase, cap, { isKickbox, asOf });
      if (cancelled) return;
      setTierSlotPriceIls(tierP);
    })();
    return () => {
      cancelled = true;
    };
  }, [maxP, date, isKickbox]);

  async function executeSaveWithScope(scope?: SeriesScope) {
    if (!isValidISODateString(date.trim())) {
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    const customParsed = parseCustomSlotPriceDraft(customSlotPriceDraft);
    if (!customParsed.ok) {
      Alert.alert(t("common.error"), t("managerSession.customSlotPriceInvalid"));
      return;
    }

    const parsedDuration = parseInt(durationMin.trim(), 10);
    const duration = clampSessionDuration(parsedDuration);
    if (!isValidSessionDuration(parsedDuration)) {
      Alert.alert(
        language === "he" ? "משך לא תקין" : "Invalid duration",
        language === "he" ? "בחרו משך בין 30 ל-120 דקות." : "Choose a duration between 30 and 120 minutes."
      );
      return;
    }
    const parsedMax = parseInt(maxP.trim(), 10);
    const maxParticipants = clampSessionMaxParticipants(parsedMax);
    if (!isValidSessionMaxParticipants(parsedMax)) {
      Alert.alert(
        language === "he" ? "גודל קבוצה לא תקין" : "Invalid group size",
        language === "he" ? "בחרו גודל קבוצה בין 0 ל-15." : "Choose a group size between 0 and 15."
      );
      return;
    }

    const sid = String(id ?? "").trim();
    const seriesScope: SeriesScope | null = session?.series_id && !session?.series_detached && scope ? scope : null;

    if (seriesScope) {
      const res = await updateSessionWithSeriesScope({
        sessionId: sid,
        scope: seriesScope,
        sessionDate: date.trim(),
        startTime: time,
        coachId: session!.coach_id,
        maxParticipants,
        durationMinutes: duration,
        isOpen: open,
        isHidden: hidden,
        isKickbox,
        customSlotPriceIls: customParsed.price,
      });
      if (!res.ok) {
        Alert.alert(
          t("common.error"),
          isMissingSessionSeriesRpc({ message: res.error })
            ? t("session.seriesNeedsDb")
            : formatSessionSeriesError(res.error, t)
        );
        return;
      }
    } else {
      const payload = {
        session_date: date.trim(),
        start_time: time,
        max_participants: maxParticipants,
        duration_minutes: duration,
        is_open_for_registration: open,
        is_hidden: hidden,
        is_kickbox: isKickbox,
      };
      const updateBody: Record<string, unknown> = { ...payload };
      let { error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid);
      let savedWithoutHidden = false;
      let savedWithoutKickbox = false;
      if (error && isMissingColumnError(error.message, "is_hidden")) {
        delete updateBody.is_hidden;
        savedWithoutHidden = true;
        ({ error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid));
      }
      if (error && isMissingColumnError(error.message, "is_kickbox")) {
        delete updateBody.is_kickbox;
        savedWithoutKickbox = true;
        ({ error } = await supabase.from("training_sessions").update(updateBody).eq("id", sid));
      }
      if (error) {
        Alert.alert(t("common.error"), error.message);
        return;
      }
      const { data: priceData, error: priceErr } = await supabase.rpc("staff_set_session_custom_slot_price", {
        p_session_id: sid,
        p_price_ils: customParsed.price,
      });
      if (priceErr || !priceData?.ok) {
        Alert.alert(
          t("common.error"),
          priceErr?.message ?? String(priceData?.error ?? t("common.failed"))
        );
        return;
      }
      if (savedWithoutHidden || savedWithoutKickbox) {
        const parts: string[] = [];
        if (savedWithoutHidden) {
          parts.push(
            language === "he"
              ? "סימון מוסתר לא נשמר (עמודה חסרה במסד)"
              : "Hidden flag was not saved (column missing)"
          );
        }
        if (savedWithoutKickbox) {
          parts.push(
            language === "he"
              ? "סימון קיקבוקס לא נשמר (עמודה חסרה במסד)"
              : "Kickbox flag was not saved (column missing)"
          );
        }
        Alert.alert(language === "he" ? "הערה" : "Note", parts.join("\n"));
      }
    }
    if (seriesScope) {
      showToast({
        message:
          seriesScope === "future"
            ? language === "he"
              ? "נשמר — אימון זה והבאים בסדרה"
              : "Saved — this and future sessions"
            : language === "he"
              ? "נשמר — רק אימון זה"
              : "Saved — only this session",
        variant: "success",
      });
    } else {
      showToast({ message: language === "he" ? "נשמר — אימון" : "Saved session", variant: "success" });
    }
    router.replace("/(app)/coach/sessions");
  }

  function saveSession() {
    if (session?.series_id && !session.series_detached) {
      setSeriesScopeOpen(true);
      return;
    }
    void executeSaveWithScope();
  }

  function onSeriesScopeChosen(scope: SeriesScopeChoice) {
    setSeriesScopeOpen(false);
    void executeSaveWithScope(scope);
  }

  async function openDuplicateModal() {
    if (!session) return;
    setDupDate(date);
    setDupTime(time);
    setDupIncludeParticipants(false);
    setDupCoachId(session.coach_id);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, username, calendar_color")
      .eq("user_id", session.coach_id)
      .maybeSingle();
    if (data) setDupCoachLabel(formatCoachOptionLabel(data as CoachOption));
    else setDupCoachLabel("");
    setDupOpen(true);
  }

  function selectDupCoach(opt: CoachOption) {
    setDupCoachId(opt.user_id);
    setDupCoachLabel(formatCoachOptionLabel(opt));
  }

  async function duplicateSession() {
    if (!session) return;
    const d = dupDate.trim();
    if (!isValidISODateString(d)) {
      Alert.alert(
        language === "he" ? "תאריך לא תקין" : "Invalid date",
        language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date."
      );
      return;
    }
    if (!dupCoachId) {
      Alert.alert(
        language === "he" ? "חסר מאמן" : "Missing trainer",
        language === "he" ? "בחרו מאמן/ת." : "Please choose a trainer."
      );
      return;
    }
    setDupBusy(true);
    const payload = {
      session_date: d,
      start_time: dupTime || time,
      coach_id: dupCoachId,
      max_participants: clampSessionMaxParticipants(parseInt(maxP.trim(), 10)),
      duration_minutes: clampSessionDuration(parseInt(durationMin.trim(), 10)),
      is_open_for_registration: false,
      is_hidden: hidden,
      is_kickbox: isKickbox,
    };
    let res = await supabase.from("training_sessions").insert(payload).select("id").maybeSingle();
    let error = res.error;
    if (error && (isMissingColumnError(error.message, "is_hidden") || isMissingColumnError(error.message, "is_kickbox"))) {
      const { is_hidden: _h, is_kickbox: _k, ...rest } = payload;
      res = await supabase.from("training_sessions").insert(rest).select("id").maybeSingle();
      error = res.error;
    }
    if (error) {
      setDupBusy(false);
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    const newId = (res.data as { id?: string } | null)?.id;
    if (newId && dupIncludeParticipants && id) {
      const errs = await copySessionParticipantsToNewSession(String(id), newId);
      if (errs.length > 0) {
        showToast({
          message: language === "he" ? "האימון שוכפל — חלק מהמשתתפים לא הועתקו" : "Session copied — some participants were not copied",
          detail: errs.slice(0, 8).join("\n"),
          variant: "error",
        });
      }
    }
    setDupBusy(false);
    setDupOpen(false);
    if (newId) router.push(`/(app)/coach/session/${newId}`);
    else router.replace("/(app)/coach/sessions");
  }

  if (forbidden) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <View style={sf.screen}>
        <Text style={[styles.err, isRTL && styles.rtlText]}>
          {language === "he"
            ? "אפשר לערוך רק אימונים שבהם אתה/את המאמן/ת."
            : "You can only edit sessions where you are the trainer."}
        </Text>
      </View>
      </>
    );
  }

  if (!ready) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <View style={sf.screen}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
        <View style={sf.screen}>
          <Text style={[styles.err, isRTL && styles.rtlText]}>{language === "he" ? "האימון לא נמצא." : "Session not found."}</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t("screen.coachManageSession") }} />
      <ScrollView style={sf.screen} contentContainerStyle={sf.content} keyboardShouldPersistTaps="handled">
      <View style={sf.sections}>
      <View style={sf.card}>
        <Text style={[sf.cardTitle, isRTL && { textAlign: "right" }]}>{language === "he" ? "מתי" : "When"}</Text>
        <SessionWhenFields
          date={date}
          time={time}
          onDateChange={(v) => {
            pushUndo();
            setDate(v);
          }}
          onTimeChange={(v) => {
            pushUndo();
            setTime(v);
          }}
          dateLabel={language === "he" ? "תאריך אימון" : "Session date"}
          timeLabel={language === "he" ? "שעת התחלה" : "Start time"}
        />
      </View>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "קיבולת" : "Capacity"}</Text>
        <SessionCapacityFields
          duration={durationMin}
          max={maxP}
          onDurationChange={(v) => {
            pushUndo();
            setDurationMin(v);
          }}
          onMaxChange={(v) => {
            pushUndo();
            setMaxP(v);
          }}
          durationLabel={t("sessionForm.lengthMin")}
          maxLabel={t("sessionForm.maxParticipants")}
        />
      </View>

      <View style={sf.card}>
        <Text style={[sf.cardTitle, isRTL && styles.toggleTextRtl]}>{t("session.optionsTitle")}</Text>
        <View style={styles.optionsPanel}>
        <SessionOptionsSection
        embedded
        isRTL={isRTL}
        options={[
          {
            key: "open",
            label: t("session.openRegistration"),
            value: open,
            onValueChange: (v) => {
              pushUndo();
              setOpen(v);
            },
            tone: "open",
          },
          {
            key: "hidden",
            label: t("session.hiddenStaffOnly"),
            value: hidden,
            onValueChange: (v) => {
              pushUndo();
              setHidden(v);
            },
            tone: "hidden",
          },
          {
            key: "kickbox",
            label: t("session.kickboxSession"),
            value: isKickbox,
            onValueChange: (v) => {
              pushUndo();
              setIsKickbox(v);
            },
            tone: "kickbox",
          },
        ]}
        />
        </View>
      </View>

      <SessionSlotRateField
        layout="form"
        value={customSlotPriceDraft}
        onChangeValue={setCustomSlotPriceDraft}
        tierPriceIls={tierSlotPriceIls}
        hasCustomOnServer={
          session?.custom_slot_price_ils != null && Number.isFinite(Number(session.custom_slot_price_ils))
        }
        serverCustomPriceIls={session?.custom_slot_price_ils ?? null}
        onClear={session?.custom_slot_price_ils != null ? () => setCustomSlotPriceDraft("") : undefined}
      />

      <View style={sf.card}>
        <View style={sf.toggleStack}>
          <Pressable
            onPress={undoLast}
            disabled={undoStack.length === 0}
            style={({ pressed }) => [
              styles.undoBtn,
              pressed && undoStack.length > 0 && { opacity: 0.85 },
              undoStack.length === 0 && { opacity: 0.45 },
            ]}
          >
            <Text style={styles.undoBtnTxt}>{language === "he" ? "ביטול שינוי אחרון" : "Undo last change"}</Text>
          </Pressable>
          <PrimaryButton label={t("common.save")} onPress={() => void saveSession()} />
          <PrimaryButton
            label={language === "he" ? "שכפול אימון…" : "Duplicate session…"}
            onPress={() => void openDuplicateModal()}
            variant="ghost"
          />
          <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.cancelEdit, pressed && { opacity: 0.85 }]}>
            <Text style={styles.cancelEditTxt}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
      </View>
      </View>

      <Modal visible={dupOpen} transparent animationType="fade" onRequestClose={() => (dupBusy ? null : setDupOpen(false))}>
        <View style={styles.dupBackdrop}>
          <Pressable style={styles.dupBackdropTouch} onPress={() => (dupBusy ? null : setDupOpen(false))} />
          <View style={styles.dupCard}>
            <Text style={[styles.dupTitle, isRTL && styles.rtlText]}>{language === "he" ? "שכפול אימון" : "Duplicate session"}</Text>
            <SessionWhenFields
              date={dupDate}
              time={dupTime}
              onDateChange={setDupDate}
              onTimeChange={setDupTime}
              dateLabel={language === "he" ? "תאריך חדש" : "New date"}
              timeLabel={language === "he" ? "שעה חדשה" : "New time"}
            />
            <SessionCoachPickerField
              coachId={dupCoachId}
              coachLabel={dupCoachLabel}
              onSelect={selectDupCoach}
              disabled={dupBusy}
            />
            <Text style={[styles.dupSectionLabel, isRTL && styles.rtlText]}>
              {language === "he" ? "משתתפים" : "Participants"}
            </Text>
            <View style={[styles.dupChoiceRow, isRTL && styles.dupChoiceRowRtl]}>
              <Pressable
                style={({ pressed }) => [
                  styles.dupChoice,
                  !dupIncludeParticipants && styles.dupChoiceOn,
                  pressed && { opacity: 0.9 },
                  dupBusy && { opacity: 0.5 },
                ]}
                onPress={() => !dupBusy && setDupIncludeParticipants(false)}
                disabled={dupBusy}
              >
                <Text style={[styles.dupChoiceTxt, !dupIncludeParticipants && styles.dupChoiceTxtOn, isRTL && styles.rtlText]}>
                  {language === "he" ? "בלי משתתפים" : "Without participants"}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.dupChoice,
                  dupIncludeParticipants && styles.dupChoiceOn,
                  pressed && { opacity: 0.9 },
                  dupBusy && { opacity: 0.5 },
                ]}
                onPress={() => !dupBusy && setDupIncludeParticipants(true)}
                disabled={dupBusy}
              >
                <Text style={[styles.dupChoiceTxt, dupIncludeParticipants && styles.dupChoiceTxtOn, isRTL && styles.rtlText]}>
                  {language === "he" ? "עם אותם נרשמים" : "With same roster"}
                </Text>
              </Pressable>
            </View>
            <View style={{ height: 12 }} />
            <PrimaryButton
              label={language === "he" ? "צור עותק" : "Create copy"}
              onPress={() => void duplicateSession()}
              loading={dupBusy}
              loadingLabel={t("common.loading")}
            />
            <Pressable style={({ pressed }) => [styles.dupCancel, pressed && { opacity: 0.85 }]} onPress={() => (dupBusy ? null : setDupOpen(false))}>
              <Text style={styles.dupCancelTxt}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
      <SessionSeriesScopeSheet
        visible={seriesScopeOpen}
        mode="edit"
        onClose={() => setSeriesScopeOpen(false)}
        onChoose={onSeriesScopeChosen}
      />
    </>
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right" },
  toggleRtl: { alignItems: "flex-end" },
  toggleTextRtl: { textAlign: "right", writingDirection: "rtl", alignSelf: "stretch", width: "100%" },
  undoBtn: {
    marginBottom: theme.spacing.sm,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  undoBtnTxt: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  muted: { marginTop: 12, color: theme.colors.textMuted },
  err: { color: theme.colors.error, fontSize: 16, fontWeight: "600" },
  cancelEdit: { marginTop: theme.spacing.sm, paddingVertical: 12, alignItems: "center" },
  cancelEditTxt: { color: theme.colors.textSoft, fontWeight: "800", fontSize: 15 },
  dupBackdrop: { flex: 1, justifyContent: "center", padding: theme.spacing.lg, backgroundColor: "rgba(0,0,0,0.55)" },
  dupBackdropTouch: { ...StyleSheet.absoluteFillObject },
  dupCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  dupTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.text, marginBottom: 6 },
  dupHint: { fontSize: 12, color: theme.colors.textSoft, lineHeight: 17, marginBottom: 10 },
  dupSectionLabel: {
    marginTop: 4,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.2,
  },
  dupChoiceRow: { flexDirection: "row", gap: 10 },
  dupChoiceRowRtl: { flexDirection: "row-reverse" },
  dupChoice: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  dupChoiceOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surface },
  dupChoiceTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted, textAlign: "center" },
  dupChoiceTxtOn: { color: theme.colors.cta, fontWeight: "900" },
  dupCancel: { marginTop: 10, paddingVertical: 10, alignItems: "center" },
  dupCancelTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  optionsPanel: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
});
