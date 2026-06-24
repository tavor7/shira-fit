import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { AppTextField } from "../components/AppTextField";
import { AppText } from "../components/AppText";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";

export default function StaffEditManualParticipantScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const manualId = String(id ?? "");
  const { t, isRTL } = useI18n();
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
        detail: t("manualParticipant.notFoundOrNoPermission"),
        variant: "error",
      });
      return;
    }
    showToast({ message: t("common.saved"), variant: "success" });
    router.back();
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <AppText variant="headline" isRTL={isRTL} style={styles.title}>
        {t("manualParticipant.editTitle")}
      </AppText>
      {loading ? (
        <AppText muted isRTL={isRTL} style={styles.muted}>
          {t("common.loading")}
        </AppText>
      ) : null}

      <AppTextField
        label={t("profile.fullName")}
        value={fullName}
        onChangeText={setFullName}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.phone")}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.gender")}
        value={gender}
        onChangeText={setGender}
        placeholder={t("manualParticipant.genderPlaceholder")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.dob")}
        value={dob}
        onChangeText={setDob}
        placeholder={t("manualParticipant.dobPlaceholder")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("manualParticipant.notes")}
        value={notes}
        onChangeText={setNotes}
        placeholder={t("manualParticipant.notesOptional")}
        isRTL={isRTL}
        multiline
        containerStyle={styles.field}
        style={styles.notesInput}
      />

      <PrimaryButton label={t("common.save")} onPress={save} loading={saving} loadingLabel={t("common.loading")} />
      <Pressable
        onPress={() => {
          router.back();
        }}
        style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.9 }]}
      >
        <AppText muted style={styles.cancelTxt}>
          {t("common.cancel")}
        </AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scrollContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xl * 2,
  },
  title: { marginBottom: theme.spacing.sm },
  muted: { marginBottom: theme.spacing.sm },
  field: { marginTop: theme.spacing.sm },
  notesInput: { minHeight: 90, textAlignVertical: "top" },
  cancel: { marginTop: theme.spacing.md, alignSelf: "center", minHeight: 44, justifyContent: "center" },
  cancelTxt: { fontWeight: "800" },
});
