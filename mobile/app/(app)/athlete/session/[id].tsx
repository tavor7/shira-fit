import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Modal, ActivityIndicator } from "react-native";
import { supabase } from "../../../../src/lib/supabase";
import type { TrainingSessionWithTrainer } from "../../../../src/types/database";
import { formatSessionTimeRange } from "../../../../src/lib/sessionTime";
import { theme } from "../../../../src/theme";
import { PrimaryButton } from "../../../../src/components/PrimaryButton";
import { ActionButton } from "../../../../src/components/ActionButton";

export default function AthleteSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
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
      const { count: c } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      setCount(c ?? 0);
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
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) {
      Alert.alert("Registered");
      setRegistered(true);
      const { count: c } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      setCount(c ?? 0);
    } else Alert.alert("Could not register", data?.error ?? "");
  }

  async function waitlist() {
    const { data, error } = await supabase.rpc("request_waitlist", { p_session_id: id });
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) {
      Alert.alert("You will be notified if a spot opens");
      setOnWaitlist(true);
    } else Alert.alert("Waitlist", data?.error ?? "");
  }

  async function cancel() {
    if (!reason.trim()) {
      Alert.alert("Reason required");
      return;
    }
    const { data, error } = await supabase.rpc("cancel_registration", {
      p_session_id: id,
      p_reason: reason.trim(),
    });
    setCancelOpen(false);
    setReason("");
    if (error) Alert.alert("Error", error.message);
    else if (data?.ok) {
      Alert.alert("Cancelled", data.charged_full_price ? "Within 12h — full price applies (recorded)." : "No late fee.");
      setRegistered(false);
      const { count: c } = await supabase
        .from("session_registrations")
        .select("*", { count: "exact", head: true })
        .eq("session_id", id)
        .eq("status", "active");
      setCount(c ?? 0);
      /* Notify waitlist: configure Supabase Cron or webhook to POST notify-waitlist with CRON_SECRET */
    } else Alert.alert("Error", data?.error ?? "");
  }

  if (!session) return <View style={styles.box}><ActivityIndicator size="large" color={theme.colors.cta} /><Text style={styles.loadingText}>Loading…</Text></View>;
  const full = count >= session.max_participants;

  return (
    <View style={styles.box}>
      <View style={styles.card}>
        <Text style={styles.title}>{session.session_date}</Text>
        <Text style={styles.sub}>{formatSessionTimeRange(session.start_time, session.duration_minutes ?? 60)}</Text>
        {session.trainer?.full_name ? <Text style={styles.sub}>Trainer: {session.trainer.full_name}</Text> : null}
        <Text style={styles.sub}>Spots: {count} / {session.max_participants}</Text>
      </View>
      {!registered ? (
        <>
          <PrimaryButton label="Register" onPress={register} disabled={full} style={full ? styles.disabled : undefined} />
          {full && (
            <Pressable style={styles.btn2} onPress={waitlist}>
              <Text style={styles.btnText2}>{onWaitlist ? "On waitlist" : "Notify if spot opens"}</Text>
            </Pressable>
          )}
        </>
      ) : (
        <Pressable style={styles.btnDanger} onPress={() => setCancelOpen(true)}>
          <Text style={styles.btnText}>Cancel registration</Text>
        </Pressable>
      )}
      <Modal visible={cancelOpen} transparent animationType="slide">
        <View style={styles.modal}>
          <View style={styles.modalCard}>
            <Text style={styles.mTitle}>Cancellation reason</Text>
            <TextInput style={styles.input} placeholder="Reason" placeholderTextColor={theme.colors.textSoft} value={reason} onChangeText={setReason} multiline />
            <PrimaryButton label="Confirm cancel" onPress={cancel} />
            <ActionButton label="Close" onPress={() => setCancelOpen(false)} style={{ marginTop: 16, alignSelf: "center" }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.backgroundAlt },
  loadingText: { marginTop: 12, color: theme.colors.textMuted },
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
