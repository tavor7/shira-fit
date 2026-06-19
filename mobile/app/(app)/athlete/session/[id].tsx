import { useLocalSearchParams, router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Modal, ActivityIndicator, ScrollView } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import type { TrainingSessionWithTrainer } from "../../../../src/types/database";
import { formatSessionTimeRange, hasSessionNotEnded, hasSessionNotStarted } from "../../../../src/lib/sessionTime";
import { formatISODateFullWithWeekdayAfter } from "../../../../src/lib/dateFormat";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ActionButton } from "../../../../src/components/ActionButton";
import { useI18n } from "../../../../src/context/I18nContext";
import { useToast } from "../../../../src/context/ToastContext";
import { useAppAlert } from "../../../../src/context/AppAlertContext";
import {
  confirmSameDaySecondRegistration,
  fetchSameDayActiveRegistrations,
} from "../../../../src/lib/athleteSameDayRegistration";
import { appendNetworkHint } from "../../../../src/lib/networkErrors";
import { StatusChip } from "../../../../src/components/StatusChip";
import { scheduleSessionReminders, cancelSessionReminders } from "../../../../src/lib/sessionReminders";
import { clearWaitlistSpotFlag } from "../../../../src/lib/waitlistSpotNotifier";
import { fetchActiveSignupCountsBySession } from "../../../../src/lib/sessionSignupCounts";
import { SessionAdjacentNav } from "../../../../src/components/SessionAdjacentNav";
import { KickboxSessionBadge } from "../../../../src/components/KickboxSessionBadge";
import { embedLtrInMixed, embedRtlInLtr, isRtlScript } from "../../../../src/lib/bidiEmbed";
import { athleteRegisterSessionErrorDetail } from "../../../../src/lib/athleteRegisterSessionError";

/** Same visual anchor for Hebrew + Latin names in the participants list. */
function participantListLabel(name: string, uiRtl: boolean): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (uiRtl) return isRtlScript(trimmed) ? trimmed : embedLtrInMixed(trimmed);
  return isRtlScript(trimmed) ? embedRtlInLtr(trimmed) : trimmed;
}

export default function AthleteSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = String(id ?? "").trim();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showAlert } = useAppAlert();
  const [session, setSession] = useState<TrainingSessionWithTrainer | null>(null);
  const [count, setCount] = useState(0);
  const [onWaitlist, setOnWaitlist] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");
  const [registering, setRegistering] = useState(false);
  const [waitlisting, setWaitlisting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const t = requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    return () => cancelAnimationFrame(t);
  }, [sessionId]);

  async function refreshCount() {
    const m = await fetchActiveSignupCountsBySession([sessionId]);
    setCount(m[sessionId] ?? 0);
  }

  async function loadNames() {
    const { data: ppl, error } = await supabase.rpc("list_session_participants", { p_session_id: sessionId });
    if (error) return;
    const list = Array.isArray(ppl) ? (ppl as { full_name: string }[]).map((x) => x.full_name).filter(Boolean) : [];
    setNames(list);
  }

  const load = useCallback(async (silent = false) => {
    if (!sessionId) {
      setLoadError(language === "he" ? "מזהה אימון חסר" : "Missing session id");
      setLoading(false);
      return;
    }

    if (!silent) setLoading(true);
    setLoadError("");

    const { data: s, error: sErr } = await supabase
      .from("training_sessions")
      .select("*, trainer:profiles!coach_id(full_name)")
      .eq("id", sessionId)
      .single();
    if (sErr || !s) {
      setSession(null);
      setLoadError(sErr?.message ?? (language === "he" ? "האימון לא נמצא" : "Session not found"));
      if (!silent) setLoading(false);
      return;
    }

    setSession(s as TrainingSessionWithTrainer);

    const m = await fetchActiveSignupCountsBySession([sessionId]);
    setCount(m[sessionId] ?? 0);

    const u = (await supabase.auth.getUser()).data.user?.id;
    if (u) {
      const { data: r } = await supabase
        .from("session_registrations")
        .select("id")
        .eq("session_id", sessionId)
        .eq("user_id", u)
        .eq("status", "active")
        .maybeSingle();
      setRegistered(!!r);
      const { data: w } = await supabase
        .from("waitlist_requests")
        .select("id")
        .eq("session_id", sessionId)
        .eq("user_id", u)
        .maybeSingle();
      setOnWaitlist(!!w);
    } else {
      setRegistered(false);
      setOnWaitlist(false);
    }

    const { data: ppl, error: pplErr } = await supabase.rpc("list_session_participants", { p_session_id: sessionId });
    if (!pplErr) {
      const list = Array.isArray(ppl) ? (ppl as { full_name: string }[]).map((x) => x.full_name).filter(Boolean) : [];
      setNames(list);
    }

    if (!silent) setLoading(false);
  }, [sessionId, language]);

  const isFirstFocus = useRef(true);
  useEffect(() => {
    isFirstFocus.current = true;
  }, [sessionId]);
  useFocusEffect(
    useCallback(() => {
      void load(!isFirstFocus.current);
      isFirstFocus.current = false;
    }, [load])
  );

  async function register() {
    if (registering || waitlisting || cancelling) return;
    if (!session || !hasSessionNotEnded(session.session_date, session.start_time, session.duration_minutes ?? 60)) {
      showToast({
        message: language === "he" ? "לא ניתן להירשם" : "Could not register",
        detail: t("athleteSession.sessionEndedNoRegister"),
        variant: "error",
      });
      return;
    }
    const u = (await supabase.auth.getUser()).data.user?.id;
    if (u) {
      const others = await fetchSameDayActiveRegistrations(u, session.session_date, sessionId);
      if (others.length > 0) {
        const ok = await confirmSameDaySecondRegistration(showAlert, {
          t,
          language,
          sessionDate: session.session_date,
          others,
        });
        if (!ok) return;
      }
    }
    setRegistering(true);
    const { data, error } = await supabase.rpc("register_for_session", { p_session_id: sessionId });
    setRegistering(false);
    if (error) showToast({ message: t("common.error"), detail: error.message, variant: "error" });
    else if (data?.ok) {
      showToast({ message: language === "he" ? "נרשמת" : "Registered", variant: "success" });
      setRegistered(true);
      await loadNames();
      if (session) {
        await scheduleSessionReminders({
          sessionId,
          sessionDate: session.session_date,
          startTime: session.start_time,
          title: language === "he" ? "תזכורת לאימון" : "Workout reminder",
          bodyNear: `${formatISODateFullWithWeekdayAfter(session.session_date, language)} · ${formatSessionTimeRange(session.start_time, session.duration_minutes ?? 60)}`,
        });
      }
      await clearWaitlistSpotFlag(sessionId);
      await refreshCount();
    } else {
      const err = String(data?.error ?? "");
      if (err === "already_registered") await load(true);
      showToast({
        message: language === "he" ? "לא ניתן להירשם" : "Could not register",
        detail: athleteRegisterSessionErrorDetail(err, t),
        variant: "error",
      });
    }
  }

  async function waitlist() {
    if (registering || waitlisting || cancelling) return;
    if (!session || !hasSessionNotEnded(session.session_date, session.start_time, session.duration_minutes ?? 60)) {
      showToast({
        message: language === "he" ? "רשימת המתנה" : "Waitlist",
        detail: t("athleteSession.sessionEndedNoRegister"),
        variant: "error",
      });
      return;
    }
    setWaitlisting(true);
    const { data, error } = await supabase.rpc("request_waitlist", { p_session_id: sessionId });
    setWaitlisting(false);
    if (error) showToast({ message: t("common.error"), detail: appendNetworkHint(error, t("network.offlineHint")), variant: "error" });
    else if (data?.ok) {
      showToast({
        message:
          language === "he" ? "תקבלו הודעה אם יתפנה מקום" : "You’ll be notified if a spot opens",
        variant: "success",
      });
      setOnWaitlist(true);
      await loadNames();
    } else showToast({ message: language === "he" ? "רשימת המתנה" : "Waitlist", detail: data?.error ?? "", variant: "error" });
  }

  async function leaveWaitlist() {
    if (registering || waitlisting || cancelling) return;
    setWaitlisting(true);
    const u = (await supabase.auth.getUser()).data.user?.id;
    if (!u) {
      setWaitlisting(false);
      return;
    }
    const { error } = await supabase
      .from("waitlist_requests")
      .delete()
      .eq("session_id", sessionId)
      .eq("user_id", u);
    setWaitlisting(false);
    if (error) {
      showToast({ message: t("common.error"), detail: appendNetworkHint(error, t("network.offlineHint")), variant: "error" });
      return;
    }
    showToast({ message: language === "he" ? "הוסרת מרשימת ההמתנה" : "Removed from waitlist", variant: "success" });
    setOnWaitlist(false);
  }

  async function cancel() {
    if (registering || waitlisting || cancelling) return;
    if (
      !session ||
      !hasSessionNotStarted(session.session_date, session.start_time)
    ) {
      showToast({
        message: language === "he" ? "לא ניתן לבטל" : "Could not cancel",
        detail: t("athleteSession.sessionStartedNoCancel"),
        variant: "error",
      });
      return;
    }
    if (!reason.trim()) {
      Alert.alert(language === "he" ? "נדרשת סיבה" : "Reason required");
      return;
    }
    setCancelling(true);
    const { data, error } = await supabase.rpc("cancel_registration", {
      p_session_id: sessionId,
      p_reason: reason.trim(),
    });
    setCancelling(false);
    setCancelOpen(false);
    setReason("");
    if (error) showToast({ message: t("common.error"), detail: appendNetworkHint(error, t("network.offlineHint")), variant: "error" });
    else if (data?.ok) {
      await cancelSessionReminders(sessionId);
      const cancelMsg =
        data.late_cancellation === true ? t("athleteSession.cancelledLateNotice") : t("athleteSession.cancelledOk");
      showToast({ message: cancelMsg, variant: "success" });
      setRegistered(false);
      await refreshCount();
      await loadNames();
      /* Notify waitlist: configure Supabase Cron or webhook to POST notify-waitlist with CRON_SECRET */
    } else {
      const err = String(data?.error ?? "");
      const detail =
        err === "session_started"
          ? t("athleteSession.sessionStartedNoCancel")
          : err || t("common.error");
      showToast({ message: language === "he" ? "לא ניתן לבטל" : "Could not cancel", detail, variant: "error" });
    }
  }

  if (loading)
    return (
      <View style={styles.box}>
        <Stack.Screen options={{ title: t("screen.athleteSession") }} />
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.loadingText, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
    );
  if (loadError)
    return (
      <View style={styles.box}>
        <Stack.Screen options={{ title: t("screen.athleteSession") }} />
        <Text style={[styles.loadingText, isRTL && styles.rtlText]}>{loadError}</Text>
        <View style={{ marginTop: theme.spacing.md }}>
          <ActionButton label={language === "he" ? "נסו שוב" : "Retry"} onPress={() => router.replace(`/(app)/athlete/session/${sessionId}`)} />
        </View>
      </View>
    );
  if (!session)
    return (
      <View style={styles.box}>
        <Stack.Screen options={{ title: t("screen.athleteSession") }} />
        <Text style={[styles.loadingText, isRTL && styles.rtlText]}>{language === "he" ? "האימון לא נמצא" : "Session not found"}</Text>
      </View>
    );
  const full = count >= session.max_participants;
  const spotsLeft = Math.max(0, session.max_participants - count);
  const regOpen = !!session.is_open_for_registration;
  const sessionNotEnded = hasSessionNotEnded(session.session_date, session.start_time, session.duration_minutes ?? 60);
  const sessionNotStarted = hasSessionNotStarted(session.session_date, session.start_time);
  const canCancelRegistration = sessionNotStarted;

  return (
    <>
      <Stack.Screen options={{ title: t("screen.athleteSession") }} />
      <View style={styles.root}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.box}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
      <View style={styles.card}>
        {session.is_kickbox ? (
          <View style={styles.kickboxBadgeWrap}>
            <KickboxSessionBadge isRTL={isRTL} />
          </View>
        ) : null}
        <Text style={styles.title}>{formatISODateFullWithWeekdayAfter(session.session_date, language)}</Text>
        <Text style={styles.sub}>{formatSessionTimeRange(session.start_time, session.duration_minutes ?? 60)}</Text>
        {session.trainer?.full_name ? (
          <Text style={[styles.sub, isRTL && styles.rtlText]}>
            {language === "he" ? "מאמן: " : "Trainer: "}
            {session.trainer.full_name}
          </Text>
        ) : null}
        <View style={[styles.chips, isRTL && styles.chipsRtl]}>
          {!sessionNotEnded ? (
            <StatusChip label={t("athleteSession.sessionEnded")} tone="neutral" />
          ) : (
            <>
              {full ? (
                <StatusChip label={language === "he" ? "מלא" : "Full"} tone="danger" />
              ) : !regOpen ? (
                <StatusChip label={language === "he" ? "סגור" : "Closed"} tone="neutral" />
              ) : (
                <StatusChip label={language === "he" ? "פתוח" : "Open"} tone="success" />
              )}
              <StatusChip
                label={language === "he" ? `${spotsLeft} פנוי` : `${spotsLeft} left`}
                tone={spotsLeft === 0 ? "danger" : "neutral"}
              />
            </>
          )}
        </View>
      </View>

      <View style={styles.actionsBlock}>
        {!registered ? (
          <>
            <PrimaryButton
              label={registering ? t("common.loading") : language === "he" ? "הרשמה" : "Register"}
              onPress={register}
              disabled={full || !regOpen || !sessionNotEnded || registering || waitlisting || cancelling}
              style={full || !regOpen || !sessionNotEnded ? styles.disabled : undefined}
            />
            {(full || onWaitlist) && (
              <Pressable
                style={styles.btn2}
                onPress={onWaitlist ? leaveWaitlist : waitlist}
                disabled={
                  waitlisting ||
                  registering ||
                  cancelling ||
                  (!onWaitlist && (!full || !sessionNotEnded))
                }
              >
                <Text style={styles.btnText2}>
                  {onWaitlist
                    ? language === "he"
                      ? "הסרה מרשימת המתנה"
                      : "Remove from waitlist"
                    : language === "he"
                      ? "הרשמה לרשימת המתנה"
                      : "Register to waitlist"}
                </Text>
              </Pressable>
            )}
            {!sessionNotEnded ? null : !full && !regOpen ? (
              <Text style={[styles.closedHint, isRTL && styles.rtlText]}>
                {language === "he" ? "ההרשמה סגורה כרגע." : "Registration is currently closed."}
              </Text>
            ) : null}
          </>
        ) : canCancelRegistration ? (
          <Pressable
            style={styles.btnDanger}
            onPress={() => setCancelOpen(true)}
            disabled={registering || waitlisting || cancelling}
          >
            <Text style={styles.btnText}>{language === "he" ? "ביטול הרשמה" : "Cancel registration"}</Text>
          </Pressable>
        ) : sessionNotEnded ? (
          <Text style={[styles.closedHint, isRTL && styles.rtlText]}>{t("athleteSession.sessionStartedNoCancel")}</Text>
        ) : null}
      </View>

      <View style={styles.partCard}>
        <View style={[styles.partHeader, isRTL && styles.partHeaderRtl]}>
          <Text style={[styles.partTitle, isRTL && styles.rtlText]}>
            {language === "he" ? "משתתפים" : "Participants"}
          </Text>
          <View style={styles.partCountBadge}>
            <Text style={styles.partCountBadgeTxt}>
              {count}/{session.max_participants}
            </Text>
          </View>
        </View>
        {names.length === 0 && count === 0 ? (
          <Text style={[styles.partEmpty, isRTL && styles.rtlText]}>
            {language === "he" ? "אין משתתפים רשומים עדיין." : "No registered participants yet."}
          </Text>
        ) : names.length === 0 ? (
          <Text style={[styles.partEmpty, isRTL && styles.rtlText]}>
            {language === "he" ? `${count} נרשמו` : `${count} registered`}
          </Text>
        ) : (
          <View style={styles.partListShell}>
            {names.slice(0, 32).map((n, i) => (
              <View key={`${n}-${i}`} style={styles.partChip}>
                <Text
                  style={[styles.partChipTxt, isRTL ? styles.partChipTxtRtlUi : styles.partChipTxtLtrUi]}
                  numberOfLines={1}
                >
                  {participantListLabel(n, isRTL)}
                </Text>
              </View>
            ))}
            {count > names.length ? (
              <Text style={[styles.partRowMore, isRTL && styles.rtlText]}>
                {language === "he" ? `+${count - names.length} נוספים` : `+${count - names.length} more`}
              </Text>
            ) : null}
            {names.length > 32 ? (
              <Text style={[styles.partRowMore, isRTL && styles.rtlText]}>
                {language === "he" ? `ועוד ${names.length - 32}` : `+${names.length - 32} more`}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
        <SessionAdjacentNav variant="athlete" sessionId={sessionId} />
      </View>
      <Modal visible={cancelOpen} transparent animationType="slide">
        <View style={styles.modal}>
          <View style={styles.modalCard}>
            <Text style={[styles.mTitle, isRTL && styles.rtlText]}>{language === "he" ? "סיבת ביטול" : "Cancellation reason"}</Text>
            <TextInput
              style={styles.input}
              placeholder={language === "he" ? "סיבה" : "Reason"}
              placeholderTextColor={theme.colors.textSoft}
              value={reason}
              onChangeText={setReason}
              multiline
            />
            <PrimaryButton
              label={cancelling ? t("common.loading") : language === "he" ? "אישור ביטול" : "Confirm cancel"}
              onPress={cancel}
              loading={cancelling}
              loadingLabel={t("common.loading")}
            />
            <ActionButton
              label={language === "he" ? "סגור" : "Close"}
              onPress={() => setCancelOpen(false)}
              style={{ marginTop: 16, alignSelf: "center" }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  box: { flexGrow: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  loadingText: { marginTop: 12, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  card: {
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  kickboxBadgeWrap: { marginBottom: 10 },
  title: { fontSize: 22, fontWeight: "700", color: theme.colors.text, letterSpacing: 0.2 },
  sub: { marginTop: 8, color: theme.colors.textMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chipsRtl: { flexDirection: "row-reverse" },
  disabled: { opacity: 0.5 },
  actionsBlock: {
    marginBottom: theme.spacing.md,
    gap: 10,
  },
  btn2: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: theme.radius.md,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
  },
  closedHint: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 13, textAlign: "center" },
  btnText: { color: "#fff", textAlign: "center", fontWeight: "600" },
  btnText2: { color: theme.colors.cta, fontWeight: "600" },
  btnDanger: {
    backgroundColor: theme.colors.error,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  partCard: {
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  partHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 8,
  },
  partHeaderRtl: { flexDirection: "row-reverse" },
  partTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  partCountBadge: {
    minWidth: 24,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
  },
  partCountBadgeTxt: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textMuted,
    fontVariant: ["tabular-nums"],
  },
  partEmpty: { color: theme.colors.textMuted, fontWeight: "600", fontSize: 12 },
  partListShell: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  partChip: {
    maxWidth: "100%",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  partChipTxt: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.text,
    lineHeight: 15,
    textAlign: "center",
  },
  partChipTxtLtrUi: {
    writingDirection: "ltr",
  },
  partChipTxtRtlUi: {
    writingDirection: "rtl",
  },
  partRowMore: {
    width: "100%",
    marginTop: 4,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textAlign: "center",
  },
  modal: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  modalCard: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  mTitle: { fontSize: 18, fontWeight: "700", marginBottom: 12, color: theme.colors.text },
  input: {
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.sm,
    padding: 12,
    minHeight: 80,
    marginBottom: 16,
    fontSize: 16,
    color: theme.colors.text,
  },
});
