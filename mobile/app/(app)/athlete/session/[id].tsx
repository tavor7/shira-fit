import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Modal, ActivityIndicator } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import type { TrainingSessionWithTrainer } from "../../../../src/types/database";
import { formatSessionTimeRange } from "../../../../src/lib/sessionTime";
import { formatISODateFull } from "../../../../src/lib/dateFormat";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ActionButton } from "../../../../src/components/ActionButton";
import { useI18n } from "../../../../src/context/I18nContext";
import { useToast } from "../../../../src/context/ToastContext";
import { appendNetworkHint } from "../../../../src/lib/networkErrors";
import { StatusChip } from "../../../../src/components/StatusChip";
import { scheduleSessionReminders, cancelSessionReminders } from "../../../../src/lib/sessionReminders";
import { clearWaitlistSpotFlag } from "../../../../src/lib/waitlistSpotNotifier";

export default function AthleteSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [session, setSession] = useState<TrainingSessionWithTrainer | null>(null);
  const [count, setCount] = useState(0);
  const [onWaitlist, setOnWaitlist] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const uid = async () => (await supabase.auth.getUser()).data.user?.id;

  useEffect(() => {
    (async () => {
      const { data: s } = await supabase
        .from("training_sessions")
        .select("*, trainer:profiles!coach_id(full_name)")
        .eq("id", id)
        .single();
      setSession(s as TrainingSessionWithTrainer);
      const { count: c1 } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      const { count: c2 } = await supabase
        .from("session_manual_participants")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id);
      setCount((c1 ?? 0) + (c2 ?? 0));
      const u = (await supabase.auth.getUser()).data.user?.id;
      if (u) {
        const { data: r } = await supabase
          .from("session_registrations")
          .select("id")
          .eq("session_id", id)
          .eq("user_id", u)
          .eq("status", "active")
          .maybeSingle();
        setRegistered(!!r);
        const { data: w } = await supabase
          .from("waitlist_requests")
          .select("id")
          .eq("session_id", id)
          .eq("user_id", u)
          .maybeSingle();
        setOnWaitlist(!!w);
      }
    })();
  }, [id]);

  async function register() {
    const { data, error } = await supabase.rpc("register_for_session", { p_session_id: id });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      Alert.alert(language === "he" ? "נרשמת" : "Registered");
      setRegistered(true);
      if (session) {
        await scheduleSessionReminders({
          sessionId: id,
          sessionDate: session.session_date,
          startTime: session.start_time,
          title: language === "he" ? "תזכורת לאימון" : "Workout reminder",
          bodyNear: `${formatISODateFull(session.session_date, language)} · ${formatSessionTimeRange(session.start_time, session.duration_minutes ?? 60)}`,
        });
      }
      await clearWaitlistSpotFlag(id);
      const { count: c1 } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      const { count: c2 } = await supabase
        .from("session_manual_participants")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id);
      setCount((c1 ?? 0) + (c2 ?? 0));
    } else Alert.alert(language === "he" ? "לא ניתן להירשם" : "Could not register", data?.error ?? "");
  }

  async function waitlist() {
    const { data, error } = await supabase.rpc("request_waitlist", { p_session_id: id });
    if (error) Alert.alert(t("common.error"), appendNetworkHint(error, t("network.offlineHint")));
    else if (data?.ok) {
      showToast({
        message:
          language === "he" ? "תקבלו הודעה אם יתפנה מקום" : "You’ll be notified if a spot opens",
        variant: "success",
      });
      setOnWaitlist(true);
    } else Alert.alert(language === "he" ? "רשימת המתנה" : "Waitlist", data?.error ?? "");
  }

  async function cancel() {
    if (!reason.trim()) {
      Alert.alert(language === "he" ? "נדרשת סיבה" : "Reason required");
      return;
    }
    const { data, error } = await supabase.rpc("cancel_registration", {
      p_session_id: id,
      p_reason: reason.trim(),
    });
    setCancelOpen(false);
    setReason("");
    if (error) Alert.alert(t("common.error"), appendNetworkHint(error, t("network.offlineHint")));
    else if (data?.ok) {
      await cancelSessionReminders(id);
      const cancelMsg = data.charged_full_price
        ? language === "he"
          ? "בוטל פחות מ-24 שעות לפני האימון — תחויב/י עבור האימון."
          : "Cancelled less than 24 hours before the workout — you will be charged for the session."
        : language === "he"
          ? "ההרשמה בוטלה."
          : "Registration cancelled.";
      showToast({ message: cancelMsg, variant: "success" });
      setRegistered(false);
      const { count: c1 } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      const { count: c2 } = await supabase
        .from("session_manual_participants")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id);
      setCount((c1 ?? 0) + (c2 ?? 0));
      /* Notify waitlist: configure Supabase Cron or webhook to POST notify-waitlist with CRON_SECRET */
    } else Alert.alert(t("common.error"), data?.error ?? "");
  }

  if (!session)
    return (
      <View style={styles.box}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.loadingText, isRTL && styles.rtlText]}>{t("common.loading")}</Text>
      </View>
    );
  const full = count >= session.max_participants;
  const spotsLeft = Math.max(0, session.max_participants - count);

  return (
    <View style={styles.box}>
      <View style={styles.card}>
        <Text style={styles.title}>{formatISODateFull(session.session_date, language)}</Text>
        <Text style={styles.sub}>{formatSessionTimeRange(session.start_time, session.duration_minutes ?? 60)}</Text>
        {session.trainer?.full_name ? (
          <Text style={[styles.sub, isRTL && styles.rtlText]}>
            {language === "he" ? "מאמן: " : "Trainer: "}
            {session.trainer.full_name}
          </Text>
        ) : null}
        <View style={[styles.chips, isRTL && styles.chipsRtl]}>
          {full ? (
            <StatusChip label={language === "he" ? "מלא" : "Full"} tone="danger" />
          ) : (
            <StatusChip label={language === "he" ? "פתוח" : "Open"} tone="success" />
          )}
          <StatusChip
            label={language === "he" ? `${spotsLeft} פנוי` : `${spotsLeft} left`}
            tone={spotsLeft === 0 ? "danger" : "neutral"}
          />
        </View>
      </View>
      {!registered ? (
        <>
          <PrimaryButton
            label={language === "he" ? "הרשמה" : "Register"}
            onPress={register}
            disabled={full}
            style={full ? styles.disabled : undefined}
          />
          {full && (
            <Pressable style={styles.btn2} onPress={waitlist}>
              <Text style={styles.btnText2}>
                {onWaitlist
                  ? language === "he"
                    ? "ברשימת המתנה"
                    : "On waitlist"
                  : language === "he"
                    ? "עדכנו אם יתפנה מקום"
                    : "Notify if spot opens"}
              </Text>
            </Pressable>
          )}
        </>
      ) : (
        <Pressable style={styles.btnDanger} onPress={() => setCancelOpen(true)}>
          <Text style={styles.btnText}>{language === "he" ? "ביטול הרשמה" : "Cancel registration"}</Text>
        </Pressable>
      )}
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
            <PrimaryButton label={language === "he" ? "אישור ביטול" : "Confirm cancel"} onPress={cancel} />
            <ActionButton
              label={language === "he" ? "סגור" : "Close"}
              onPress={() => setCancelOpen(false)}
              style={{ marginTop: 16, alignSelf: "center" }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
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
  title: { fontSize: 22, fontWeight: "700", color: theme.colors.text, letterSpacing: 0.2 },
  sub: { marginTop: 8, color: theme.colors.textMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chipsRtl: { flexDirection: "row-reverse" },
  disabled: { opacity: 0.5 },
  btn2: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 16,
    borderRadius: theme.radius.md,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
  },
  btnText: { color: "#fff", textAlign: "center", fontWeight: "600" },
  btnText2: { color: theme.colors.cta, fontWeight: "600" },
  btnDanger: { marginTop: 24, backgroundColor: theme.colors.error, padding: 16, borderRadius: theme.radius.md, alignItems: "center" },
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
