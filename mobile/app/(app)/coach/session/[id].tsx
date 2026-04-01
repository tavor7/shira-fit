import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Alert } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";
import { AddParticipantToSessionModal } from "../../../../src/components/AddParticipantToSessionModal";
import { useI18n } from "../../../../src/context/I18nContext";
import { formatDateTimeForDisplay } from "../../../../src/lib/dateFormat";

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
  const [coachId, setCoachId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);

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
    void (async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
      setMyId(uid);
      const { data: s } = await supabase.from("training_sessions").select("coach_id").eq("id", id).single();
      setCoachId((s as { coach_id?: string } | null)?.coach_id ?? null);
    })();
  }, [id]);

  async function removeAthlete(userId: string) {
    const { data, error } = await supabase.rpc("coach_remove_athlete", { p_session_id: id, p_user_id: userId });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  async function removeManual(manualId: string) {
    const { data, error } = await supabase.rpc("remove_manual_participant_from_session", {
      p_session_id: id,
      p_manual_participant_id: manualId,
    });
    if (error) Alert.alert(t("common.error"), error.message);
    else if (data?.ok) {
      setParticipantsRev((n) => n + 1);
    } else Alert.alert(t("common.failed"), data?.error ?? "");
  }

  const canEditSession = !!(myId && coachId && myId === coachId);

  function afterParticipantsChange() {
    loadWaitlist();
    loadCancellations();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {canEditSession ? (
        <PrimaryButton
          label={language === "he" ? "עריכת אימון" : "Edit session"}
          onPress={() => router.push(`/(app)/coach/session/manage/${id}`)}
          variant="ghost"
        />
      ) : null}

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "משתתפים ונוכחות" : "Participants & attendance"}</Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={afterParticipantsChange}
        onRemoveAthlete={removeAthlete}
        onRemoveManualParticipant={removeManual}
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
        onPress={() => setAddOpen(true)}
        variant="ghost"
      />

      <Text style={[styles.h, isRTL && styles.rtlText]}>{language === "he" ? "ביטולים" : "Cancellations"}</Text>
      {cancellations.length === 0 ? (
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "אין" : "None"}</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{formatDateTimeForDisplay(c.cancelled_at, language)}</Text>
              <Text style={styles.cancelReason}>
                {language === "he" ? "סיבה: " : "Reason: "}
                {c.reason}
              </Text>
              {c.charged_full_price ? (
                <Text style={styles.chargeWarn}>
                  {language === "he" ? "ביטול מאוחר (<24ש׳) — חיוב" : "Late cancellation (<24h) — charged"}
                </Text>
              ) : null}
            </View>
          );
        })
      )}

      <AddParticipantToSessionModal
        sessionId={id}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          afterParticipantsChange();
          setParticipantsRev((n) => n + 1);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: 4 },
  h: { fontWeight: "700", marginTop: theme.spacing.md, marginBottom: 8, color: theme.colors.text },
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
});
