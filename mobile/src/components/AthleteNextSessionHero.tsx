import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, Modal, TextInput } from "react-native";
import { router } from "expo-router";
import type { TrainingSessionWithTrainer } from "../types/database";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { formatISODateFull } from "../lib/dateFormat";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { PrimaryButton } from "./PrimaryButton";
import { StatusChip } from "./StatusChip";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { appendNetworkHint } from "../lib/networkErrors";
import { scheduleSessionReminders, cancelSessionReminders } from "../lib/sessionReminders";
import { clearWaitlistSpotFlag } from "../lib/waitlistSpotNotifier";

function sessionStartMs(s: Pick<TrainingSessionWithTrainer, "session_date" | "start_time">): number {
  const t = s.start_time.length >= 5 ? s.start_time.slice(0, 5) : s.start_time;
  return new Date(`${s.session_date}T${t}:00`).getTime();
}

type Props = {
  sessions: TrainingSessionWithTrainer[];
  signupBySession: Record<string, number>;
  onDidChange?: () => void;
};

export function AthleteNextSessionHero({ sessions, signupBySession, onDidChange }: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [userId, setUserId] = useState<string | null>(null);
  const [regId, setRegId] = useState<string | null>(null);
  const [waitlist, setWaitlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");

  const next = useMemo(() => {
    const now = Date.now();
    const upcoming = sessions
      .filter((s) => sessionStartMs(s) > now)
      .sort((a, b) => sessionStartMs(a) - sessionStartMs(b));
    return upcoming[0] ?? null;
  }, [sessions]);

  const loadStatus = useCallback(async () => {
    if (!next) {
      setUserId(null);
      setRegId(null);
      setWaitlist(false);
      return;
    }
    const u = (await supabase.auth.getUser()).data.user?.id ?? null;
    setUserId(u);
    if (!u) return;
    const { data: r } = await supabase
      .from("session_registrations")
      .select("id")
      .eq("session_id", next.id)
      .eq("user_id", u)
      .eq("status", "active")
      .maybeSingle();
    setRegId(r?.id ? String(r.id) : null);
    const { data: w } = await supabase
      .from("waitlist_requests")
      .select("id")
      .eq("session_id", next.id)
      .eq("user_id", u)
      .maybeSingle();
    setWaitlist(!!w);
  }, [next]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const count = next ? signupBySession[next.id] ?? 0 : 0;
  const max = next?.max_participants ?? 0;
  const full = next ? count >= max : false;
  const spotsLeft = Math.max(0, max - count);

  async function onRegister() {
    if (!next) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("register_for_session", { p_session_id: next.id });
    setBusy(false);
    if (error) {
      Alert.alert(t("common.error"), appendNetworkHint(error, t("network.offlineHint")));
      return;
    }
    if (data?.ok) {
      const when = `${formatISODateFull(next.session_date, language)} · ${formatSessionTimeRange(next.start_time, next.duration_minutes ?? 60)}`;
      await scheduleSessionReminders({
        sessionId: next.id,
        sessionDate: next.session_date,
        startTime: next.start_time,
        title: language === "he" ? "תזכורת לאימון" : "Workout reminder",
        bodyNear: when,
      });
      await clearWaitlistSpotFlag(next.id);
      await loadStatus();
      onDidChange?.();
      showToast({
        message: language === "he" ? "נרשמת לאימון" : "You’re registered",
        variant: "success",
      });
    } else Alert.alert(language === "he" ? "לא ניתן להירשם" : "Could not register", data?.error ?? "");
  }

  async function onWaitlist() {
    if (!next) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("request_waitlist", { p_session_id: next.id });
    setBusy(false);
    if (error) Alert.alert(t("common.error"), appendNetworkHint(error, t("network.offlineHint")));
    else if (data?.ok) {
      setWaitlist(true);
      showToast({
        message: language === "he" ? "נרשמתם לרשימת המתנה" : "You’re on the waitlist",
        variant: "success",
      });
    } else Alert.alert(language === "he" ? "רשימת המתנה" : "Waitlist", data?.error ?? "");
  }

  async function onCancel() {
    if (!next || !reason.trim()) {
      Alert.alert(language === "he" ? "נדרשת סיבה" : "Reason required");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("cancel_registration", {
      p_session_id: next.id,
      p_reason: reason.trim(),
    });
    setBusy(false);
    setCancelOpen(false);
    setReason("");
    if (error) Alert.alert(t("common.error"), appendNetworkHint(error, t("network.offlineHint")));
    else if (data?.ok) {
      await cancelSessionReminders(next.id);
      setRegId(null);
      onDidChange?.();
      showToast({
        message: language === "he" ? "ההרשמה בוטלה" : "Registration cancelled",
        variant: "success",
      });
    } else Alert.alert(t("common.error"), data?.error ?? "");
  }

  if (!next) {
    return (
      <View style={[styles.hero, surface.hero]}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{language === "he" ? "האימון הקרוב" : "Next workout"}</Text>
        <Text style={[styles.muted, isRTL && styles.rtl]}>{language === "he" ? "אין אימון קרוב." : "No upcoming session."}</Text>
        <Pressable style={styles.linkBtn} onPress={() => router.push("/(app)/athlete/sessions")}>
          <Text style={styles.linkTxt}>{language === "he" ? "לוח אימונים" : "Calendar"}</Text>
        </Pressable>
      </View>
    );
  }

  const primaryLabel = regId
    ? language === "he"
      ? "ביטול הרשמה"
      : "Cancel registration"
    : full
      ? waitlist
        ? language === "he"
          ? "ברשימת המתנה"
          : "On waitlist"
        : language === "he"
          ? "רשימת המתנה"
          : "Join waitlist"
      : language === "he"
        ? "הרשמה"
        : "Register";

  const chips = (
    <View style={[styles.chips, isRTL && styles.chipsRtl]}>
      <StatusChip label={language === "he" ? "פתוח" : "Open"} tone="success" />
      {full ? <StatusChip label={language === "he" ? "מלא" : "Full"} tone="danger" /> : null}
      {regId ? <StatusChip label={language === "he" ? "נרשמת" : "Registered"} tone="info" /> : null}
      {waitlist && !regId ? <StatusChip label={language === "he" ? "המתנה" : "Waitlist"} tone="warning" /> : null}
    </View>
  );

  return (
    <View style={[styles.hero, surface.hero]}>
      <Text style={[styles.kicker, isRTL && styles.rtl]}>{language === "he" ? "היום / הקרוב" : "Up next"}</Text>
      <Text style={[styles.title, isRTL && styles.rtl]}>{formatISODateFull(next.session_date, language)}</Text>
      <Text style={[styles.sub, isRTL && styles.rtl]}>{formatSessionTimeRange(next.start_time, next.duration_minutes ?? 60)}</Text>
      {next.trainer?.full_name ? (
        <Text style={[styles.sub, isRTL && styles.rtl]} numberOfLines={1}>
          {next.trainer.full_name}
        </Text>
      ) : null}
      {chips}
      <Text style={[styles.spots, isRTL && styles.rtl]}>
        {language === "he" ? "נותרו: " : "Left: "}
        {spotsLeft}
      </Text>

      {busy ? <ActivityIndicator color={theme.colors.cta} style={{ marginTop: 12 }} /> : null}

      {!busy && regId ? (
        <PrimaryButton
          label={primaryLabel}
          onPress={() => setCancelOpen(true)}
          variant="ghost"
          style={{ marginTop: theme.spacing.md }}
        />
      ) : !busy && !regId ? (
        <PrimaryButton
          label={primaryLabel}
          onPress={full ? (waitlist ? () => router.push(`/(app)/athlete/session/${next.id}`) : onWaitlist) : onRegister}
          disabled={full && waitlist}
          style={{ marginTop: theme.spacing.md }}
        />
      ) : null}

      <Pressable style={styles.detailTap} onPress={() => router.push(`/(app)/athlete/session/${next.id}`)} disabled={busy}>
        <Text style={styles.detailTapTxt}>{language === "he" ? "פרטים" : "Details"}</Text>
      </Pressable>

      <Modal visible={cancelOpen} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={[styles.modalTitle, isRTL && styles.rtl]}>{language === "he" ? "סיבת ביטול" : "Cancellation reason"}</Text>
            <TextInput
              style={styles.input}
              placeholder="…"
              placeholderTextColor={theme.colors.textSoft}
              value={reason}
              onChangeText={setReason}
              multiline
            />
            <PrimaryButton label={language === "he" ? "אישור" : "Confirm"} onPress={onCancel} />
            <Pressable onPress={() => setCancelOpen(false)} style={{ marginTop: 12 }}>
              <Text style={styles.cancelTxt}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: theme.spacing.md },
  kicker: { fontSize: 11, fontWeight: "800", color: theme.colors.textSoft, letterSpacing: 0.6, textTransform: "uppercase" },
  title: { marginTop: 6, fontSize: 20, fontWeight: "900", color: theme.colors.text },
  sub: { marginTop: 4, fontSize: 14, color: theme.colors.textMuted, fontWeight: "600" },
  muted: { marginTop: 8, color: theme.colors.textSoft, fontSize: 14 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chipsRtl: { flexDirection: "row-reverse" },
  spots: { marginTop: 10, fontSize: 16, fontWeight: "800", color: theme.colors.cta },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  linkBtn: { marginTop: 12, alignSelf: "flex-start" },
  linkTxt: { color: theme.colors.cta, fontWeight: "800" },
  detailTap: { marginTop: 10, alignSelf: "flex-start" },
  detailTapTxt: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 13 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  modalCard: { ...surface.card, backgroundColor: theme.colors.surfaceElevated },
  modalTitle: { fontWeight: "800", fontSize: 16, marginBottom: 8, color: theme.colors.text },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.sm,
    padding: 12,
    color: theme.colors.text,
    minHeight: 80,
    textAlignVertical: "top",
    marginBottom: 12,
  },
  cancelTxt: { textAlign: "center", color: theme.colors.textMuted, fontWeight: "700" },
});
