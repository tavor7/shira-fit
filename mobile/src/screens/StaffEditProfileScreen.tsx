import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { useI18n } from "../context/I18nContext";

export default function StaffEditProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const userId = String(id ?? "");
  const { t, isRTL, language } = useI18n();

  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState("");
  const [dob, setDob] = useState("");
  const [saving, setSaving] = useState(false);

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
      setGender((data as any).gender ?? "");
      setDob((data as any).date_of_birth ?? "");
    })();
  }, [userId]);

  async function save() {
    setSaving(true);
    const { data, error } = await supabase.rpc("staff_update_profile", {
      p_user_id: userId,
      p_full_name: fullName.trim() || null,
      p_phone: phone.trim() || null,
      p_gender: gender.trim() || null,
      p_date_of_birth: dob.trim() ? dob.trim() : null,
    });
    setSaving(false);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      Alert.alert(t("common.failed"), data?.error ?? "Unknown error");
      return;
    }
    Alert.alert(t("common.saved"));
    router.back();
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
      <TextInput style={styles.input} value={gender} onChangeText={setGender} placeholder="male / female" placeholderTextColor={theme.colors.textSoft} />

      <Text style={[styles.label, isRTL && styles.rtlText]}>{t("profile.dob")}</Text>
      <TextInput style={styles.input} value={dob} onChangeText={setDob} placeholder="2000-01-15" placeholderTextColor={theme.colors.textSoft} />

      <PrimaryButton label={t("common.save")} onPress={save} loading={saving} loadingLabel={t("common.loading")} />

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
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
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

