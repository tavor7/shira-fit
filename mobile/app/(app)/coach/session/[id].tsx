import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, TextInput, Modal } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ParticipantAttendanceList } from "../../../../src/components/ParticipantAttendanceList";

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
  const [participantsRev, setParticipantsRev] = useState(0);
  const [waitlist, setWaitlist] = useState<W[]>([]);
  const [cancellations, setCancellations] = useState<CancellationRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [athleteId, setAthleteId] = useState("");

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

  async function addAthlete() {
    if (!athleteId.trim()) return;
    const { data, error } = await supabase.rpc("coach_add_athlete", {
      p_session_id: id,
      p_user_id: athleteId.trim(),
    });
    setAddOpen(false);
    setAthleteId("");
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) {
      Alert.alert("Added");
      loadWaitlist();
      loadCancellations();
      setParticipantsRev((n) => n + 1);
    } else Alert.alert("Failed", data?.error ?? "");
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h}>Participants & attendance</Text>
      <Text style={styles.sub}>
        Mark who arrived after the session (or anytime). Athletes with an active registration appear here.
      </Text>
      <ParticipantAttendanceList
        sessionId={id}
        refreshNonce={participantsRev}
        onChanged={() => {
          loadWaitlist();
          loadCancellations();
        }}
      />

      <Text style={styles.h}>Waitlist</Text>
      {waitlist.length === 0 ? (
        <Text style={styles.muted}>None</Text>
      ) : (
        waitlist.map((item) => (
          <Text key={item.user_id} style={styles.row}>
            {item.profiles?.full_name ?? item.user_id}
          </Text>
        ))
      )}
      <PrimaryButton label="Manual add athlete (user_id UUID)" onPress={() => setAddOpen(true)} variant="ghost" />

      <Text style={styles.h}>Cancellations</Text>
      <Text style={styles.sub}>Visible to coaches and managers only.</Text>
      {cancellations.length === 0 ? (
        <Text style={styles.muted}>None</Text>
      ) : (
        cancellations.map((c) => {
          const p = c.profiles ? (Array.isArray(c.profiles) ? c.profiles[0] : c.profiles) : null;
          const name = p?.full_name ?? c.user_id;
          return (
            <View key={`${c.user_id}-${c.cancelled_at}`} style={styles.cancelCard}>
              <Text style={styles.cancelName}>{name}</Text>
              <Text style={styles.cancelMeta}>{new Date(c.cancelled_at).toLocaleString()}</Text>
              <Text style={styles.cancelReason}>Reason: {c.reason}</Text>
              {c.charged_full_price ? <Text style={styles.chargeWarn}>Late cancellation (&lt;24h) — charged</Text> : null}
            </View>
          );
        })
      )}
      <Modal visible={addOpen} transparent>
        <View style={styles.modal}>
          <View style={styles.modalCard}>
            <TextInput
              style={styles.input}
              placeholder="Athlete user UUID"
              placeholderTextColor={theme.colors.textSoft}
              value={athleteId}
              onChangeText={setAthleteId}
              autoCapitalize="none"
            />
            <PrimaryButton label="Add" onPress={addAthlete} />
            <Pressable onPress={() => setAddOpen(false)}>
              <Text style={styles.cancel}>Cancel</Text>
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
