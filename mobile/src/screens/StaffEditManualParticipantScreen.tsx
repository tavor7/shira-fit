import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { usePersistedState } from "../hooks/usePersistedState";
import { uiDraftStorageKey } from "../lib/uiDraftStorage";

const STAFF_MANUAL_DRAFT_V = 1 as const;

type StaffManualUiDraft = {
  v: typeof STAFF_MANUAL_DRAFT_V;
  fullName: string;
  phone: string;
  gender: string;
  dob: string;
  notes: string;
};

const INITIAL_STAFF_MANUAL_DRAFT: StaffManualUiDraft = {
  v: STAFF_MANUAL_DRAFT_V,
  fullName: "",
  phone: "",
  gender: "",
  dob: "",
  notes: "",
};

export default function StaffEditManualParticipantScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const manualId = String(id ?? "");
  const { user } = useAuth();
  const manualDraftKey = uiDraftStorageKey(user?.id, `staff-manual:${manualId}`);
  const [manualDraft, setManualDraft, persistManual] = usePersistedState(manualDraftKey, INITIAL_STAFF_MANUAL_DRAFT);
  const manualHydrateGate = useRef<string | null>(null);
  const canSyncManualDraft = useRef(false);
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState("");
  const [dob, setDob] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  /** Snapshot from DB — used to keep NOT NULL columns when the user clears a field (same as RPC coalesce). */
  const [baseline, setBaseline] = useState<{
    full_name: string;
    phone: string;
    gender: string | null;
    date_of_birth: string | null;
    notes: string | null;
  } | null>(null);

  useEffect(() => {
    manualHydrateGate.current = null;
    canSyncManualDraft.current = false;
  }, [manualDraftKey]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("manual_participants")
        .select("full_name, phone, gender, date_of_birth, notes")
        .eq("id", manualId)
        .single();
      setLoading(false);
      if (error || !data) return;
      const row = data as {
        full_name: string;
        phone: string;
        gender: string | null;
        date_of_birth: string | null;
        notes: string | null;
      };
      setBaseline(row);
      setFullName(row.full_name ?? "");
      setPhone(row.phone ?? "");
      setGender(row.gender ?? "");
      setDob(row.date_of_birth ?? "");
      setNotes(row.notes ?? "");
    })();
  }, [manualId]);

  useEffect(() => {
    if (loading || !baseline || !persistManual.hydrated) return;
    if (manualHydrateGate.current === manualDraftKey) return;
    const d = manualDraft;
    if (d.v !== STAFF_MANUAL_DRAFT_V) return;
    manualHydrateGate.current = manualDraftKey;
    const hasMeaningfulDraft =
      d.fullName.trim().length > 0 ||
      d.phone.trim().length > 0 ||
      d.gender.trim().length > 0 ||
      d.dob.trim().length > 0 ||
      d.notes.trim().length > 0;
    if (!hasMeaningfulDraft) {
      canSyncManualDraft.current = true;
      return;
    }
    setFullName(d.fullName);
    setPhone(d.phone);
    setGender(d.gender);
    setDob(d.dob);
    setNotes(d.notes);
    canSyncManualDraft.current = true;
  }, [loading, baseline, manualDraftKey, manualDraft, persistManual.hydrated]);

  useEffect(() => {
    if (!persistManual.hydrated || !canSyncManualDraft.current) return;
    const next: StaffManualUiDraft = {
      v: STAFF_MANUAL_DRAFT_V,
      fullName,
      phone,
      gender,
      dob,
      notes,
    };
    setManualDraft((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [persistManual.hydrated, fullName, phone, gender, dob, notes]);

  async function save() {
    if (!baseline) return;
    setSaving(true);
    const patch = {
      full_name: fullName.trim() || baseline.full_name,
      phone: phone.trim() || baseline.phone,
      gender: (gender.trim() ? gender.trim() : baseline.gender) as string | null,
      date_of_birth: (dob.trim() ? dob.trim() : baseline.date_of_birth) as string | null,
      notes: notes as string | null,
    };
    const { data, error } = await supabase.from("manual_participants").update(patch).eq("id", manualId).select("id");
    setSaving(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.length) {
      showToast({
        message: t("common.failed"),
        detail: language === "he" ? "לא נמצא רשומה או אין הרשאה." : "Record not found or no permission.",
        variant: "error",
      });
      return;
    }
    showToast({ message: t("common.saved"), variant: "success" });
    void persistManual.clearPersisted();
    router.back();
  }

  return (
    <View style={styles.screen}>
      <Text style={[styles.title, isRTL && styles.rtlText]}>{language === "he" ? "עריכת מתאמן" : "Edit participant"}</Text>
      {loading ? <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.loading")}</Text> : null}

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.fullName")}</Text>
      <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.phone")}</Text>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.gender")}</Text>
      <TextInput style={styles.input} value={gender} onChangeText={setGender} placeholder="male / female" placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.dob")}</Text>
      <TextInput style={styles.input} value={dob} onChangeText={setDob} placeholder="2000-01-15" placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "הערות" : "Notes"}</Text>
      <TextInput
        style={[styles.input, { minHeight: 90, textAlignVertical: "top" }, isRTL && { textAlign: "right" }]}
        value={notes}
        onChangeText={setNotes}
        placeholder={language === "he" ? "אופציונלי" : "Optional"}
        placeholderTextColor={theme.colors.textSoft}
        multiline
      />

      <PrimaryButton label={t("common.save")} onPress={save} loading={saving} loadingLabel={t("common.loading")} />
      <Pressable
        onPress={() => {
          void persistManual.clearPersisted();
          router.back();
        }}
        style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.cancelTxt}>{t("common.cancel")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.sm },
  muted: { color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  label: { marginTop: theme.spacing.sm, fontWeight: "700", color: theme.colors.text, fontSize: 13 },
  rtlText: { textAlign: "right" },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  cancel: { marginTop: theme.spacing.md, alignSelf: "center" },
  cancelTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});

