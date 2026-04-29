import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { DatePickerField } from "../components/DatePickerField";
import { isValidISODateString } from "../lib/isoDate";
import { useAuth } from "../context/AuthContext";

export default function StaffEditProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const userId = String(id ?? "");
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();
  const { profile } = useAuth();
  const isManager = profile?.role === "manager";

  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [dob, setDob] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingEmail, setConfirmingEmail] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, phone, gender, date_of_birth")
        .eq("user_id", userId)
        .single();
      setLoading(false);
      if (error || !data) return;
      setFullName((data as any).full_name ?? "");
      setPhone((data as any).phone ?? "");
      const g = String((data as any).gender ?? "").trim().toLowerCase();
      setGender(g === "male" || g === "female" ? (g as any) : "");
      setDob((data as any).date_of_birth ?? "");
    })();
  }, [userId]);

  async function save() {
    setSaving(true);
    // Important: omit optional params when empty.
    // Passing `null` sometimes prevents PostgREST from resolving the correct
    // function signature in the schema cache (it can't infer types for nulls).
    const payload: Record<string, unknown> = { p_user_id: userId };
    const full = fullName.trim();
    const ph = phone.trim();
    const gen = gender;
    const dobTrim = dob.trim();

    if (full.length > 0) payload.p_full_name = full;
    if (ph.length > 0) payload.p_phone = ph;
    if (gen.length > 0) payload.p_gender = gen;
    if (dobTrim.length > 0 && isValidISODateString(dobTrim)) payload.p_date_of_birth = dobTrim;

    const { data, error } = await supabase.rpc("staff_update_profile_text", payload as any);
    setSaving(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.ok) {
      showToast({ message: t("common.failed"), detail: data?.error ?? "Unknown error", variant: "error" });
      return;
    }
    showToast({ message: t("common.saved"), variant: "success" });
    router.back();
  }

  async function confirmEmail() {
    if (!isManager) return;
    const uid = userId.trim();
    if (!uid) return;
    setConfirmingEmail(true);
    const { data, error } = await supabase.functions.invoke("admin-confirm-email", { body: { user_id: uid } });
    setConfirmingEmail(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.ok) {
      showToast({ message: t("common.failed"), detail: data?.error ?? "Unknown error", variant: "error" });
      return;
    }
    showToast({ message: language === "he" ? "האימייל אושר" : "Email confirmed", variant: "success" });
  }

  return (
    <View style={styles.screen}>
      <Text style={[styles.title, isRTL && styles.rtlText]}>{t("profile.editUser")}</Text>
      {loading ? <Text style={[styles.muted, isRTL && styles.rtlText]}>{t("common.loading")}</Text> : null}

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.fullName")}</Text>
      <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.phone")}</Text>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.gender")}</Text>
      <View style={[styles.genderRow, isRTL && styles.genderRowRtl]}>
        <Pressable
          onPress={() => setGender("male")}
          style={({ pressed }) => [styles.genderBtn, gender === "male" && styles.genderBtnOn, pressed && { opacity: 0.9 }]}
          accessibilityRole="button"
        >
          <Text style={[styles.genderTxt, gender === "male" && styles.genderTxtOn]}>{language === "he" ? "זכר" : "Male"}</Text>
        </Pressable>
        <Pressable
          onPress={() => setGender("female")}
          style={({ pressed }) => [styles.genderBtn, gender === "female" && styles.genderBtnOn, pressed && { opacity: 0.9 }]}
          accessibilityRole="button"
        >
          <Text style={[styles.genderTxt, gender === "female" && styles.genderTxtOn]}>{language === "he" ? "נקבה" : "Female"}</Text>
        </Pressable>
      </View>

      <DatePickerField label={t("profile.dob")} value={dob} onChange={setDob} />

      <PrimaryButton label={t("common.save")} onPress={save} loading={saving} loadingLabel={t("common.loading")} />

      {isManager ? (
        <Pressable
          onPress={confirmEmail}
          disabled={confirmingEmail}
          style={({ pressed }) => [
            styles.confirmEmailBtn,
            confirmingEmail && { opacity: 0.6 },
            pressed && !confirmingEmail && { opacity: 0.9 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={language === "he" ? "אישור אימייל" : "Confirm email"}
        >
          <Text style={styles.confirmEmailTxt}>
            {confirmingEmail ? t("common.loading") : language === "he" ? "אישור אימייל" : "Confirm email"}
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={() => router.replace("/(app)/staff/users")}
        style={({ pressed }) => [styles.backToList, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.backToListTxt}>{t("common.backToUsers")}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.9 }]}>
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
  genderRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  genderRowRtl: { flexDirection: "row-reverse" },
  genderBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  genderBtnOn: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  genderTxt: { fontWeight: "900", color: theme.colors.textMuted, letterSpacing: 0.2 },
  genderTxtOn: { color: theme.colors.ctaText },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  confirmEmailBtn: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmEmailTxt: { color: theme.colors.text, fontWeight: "900", letterSpacing: 0.2 },
  backToList: {
    marginTop: theme.spacing.md,
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  backToListTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  cancel: { marginTop: theme.spacing.md, alignSelf: "center" },
  cancelTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});

