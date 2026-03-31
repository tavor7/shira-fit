import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Image,
} from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { DatePickerField } from "../../src/components/DatePickerField";
import { theme } from "../../src/theme";
import { parseISODateLocal, toISODateLocal, isValidISODateString } from "../../src/lib/isoDate";

const today = new Date();
const minDob = new Date(1900, 0, 1);

function getSignupErrorMessage(error: { message: string }): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return "This email is already in use. Sign in or use Forgot password.";
  }
  return error.message || "Signup failed. Please try again.";
}

export default function SignupScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [dobText, setDobText] = useState("2000-01-15");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [healthConfirmed, setHealthConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const healthUrl = "https://tpz.link/gdtw8";

  async function onSignup() {
    setErrorMessage("");
    if (!email.trim() || password.length < 6 || !fullName.trim() || !phone.trim()) {
      setErrorMessage("Please fill in email, password (min 6), full name, and phone.");
      return;
    }
    if (!healthConfirmed) {
      setErrorMessage("Please complete the health declaration and confirm it before signing up.");
      return;
    }
    if (!isValidISODateString(dobText.trim())) {
      setErrorMessage("Please choose a valid date of birth.");
      return;
    }
    const dobFinal = parseISODateLocal(dobText.trim())!;
    if (dobFinal > today || dobFinal < minDob) {
      setErrorMessage("Date of birth must be between 1900 and today.");
      return;
    }
    const dobIso = toISODateLocal(dobFinal);
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: phone.trim(),
          date_of_birth: dobIso,
          gender,
        },
      },
    });
    if (error) {
      setBusy(false);
      setErrorMessage(getSignupErrorMessage(error));
      return;
    }
    if (data.user) {
      await supabase
        .from("profiles")
        .update({
          full_name: fullName.trim(),
          phone: phone.trim(),
          gender,
          date_of_birth: dobIso,
          age: new Date().getFullYear() - dobFinal.getFullYear(),
          health_declaration_confirmed_at: new Date().toISOString(),
        })
        .eq("user_id", data.user.id);
    }
    setBusy(false);
    router.replace({
      pathname: "/(auth)/signup-success",
      params: { email: email.trim() },
    });
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
        </View>
        <Text style={styles.title}>Create account</Text>
        <Text style={styles.hint}>Athlete account — approval required before booking.</Text>
        {errorMessage ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={(t) => { setEmail(t); setErrorMessage(""); }}
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 6)"
          placeholderTextColor={theme.colors.textSoft}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={theme.colors.textSoft} value={fullName} onChangeText={setFullName} />
        <TextInput style={styles.input} placeholder="Phone" placeholderTextColor={theme.colors.textSoft} keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
        <DatePickerField
          label="Date of birth"
          value={dobText}
          onChange={(iso) => {
            setDobText(iso);
            setErrorMessage("");
          }}
          minimumDate={minDob}
          maximumDate={today}
        />
        <Text style={styles.label}>Gender</Text>
        <View style={styles.genderRow}>
          {(["male", "female"] as const).map((g) => (
            <Pressable
              key={g}
              style={[styles.genderBtn, gender === g && styles.genderBtnOn]}
              onPress={() => setGender(g)}
            >
              <Text style={[styles.genderTxt, gender === g && styles.genderTxtOn]}>
                {g === "male" ? "Male" : "Female"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.label}>Health declaration (required)</Text>
        <Pressable
          style={({ pressed }) => [styles.healthLink, pressed && { opacity: 0.9 }]}
          onPress={() => Linking.openURL(healthUrl)}
        >
          <Text style={styles.healthLinkTxt}>Open health declaration form</Text>
          <Text style={styles.healthLinkSub}>{healthUrl}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.checkRow, pressed && { opacity: 0.9 }]}
          onPress={() => {
            setHealthConfirmed((v) => !v);
            setErrorMessage("");
          }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: healthConfirmed }}
        >
          <View style={[styles.checkbox, healthConfirmed && styles.checkboxOn]}>
            {healthConfirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
          </View>
          <Text style={styles.checkTxt}>I completed the health declaration</Text>
        </Pressable>
        <PrimaryButton label="Sign up" loadingLabel="Creating account…" loading={busy} onPress={onSignup} />
        <ActionButton label="Already have an account" onPress={() => router.push("/(auth)/login")} style={styles.navBtn} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: theme.spacing.lg, paddingBottom: 48, backgroundColor: theme.colors.background },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.md },
  logo: { width: 200, height: 200 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 6, color: theme.colors.text },
  hint: { color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error, fontSize: 14, lineHeight: 20 },
  label: { fontWeight: "600", marginBottom: 6, marginTop: 4, color: theme.colors.text },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 14,
    marginBottom: 10,
    fontSize: 16,
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  genderRow: { flexDirection: "row", gap: theme.spacing.sm, marginBottom: theme.spacing.md },
  genderBtn: {
    flex: 1,
    padding: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    alignItems: "center",
  },
  genderBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  genderTxt: { fontSize: 16, color: theme.colors.text },
  genderTxtOn: { color: theme.colors.ctaText, fontWeight: "600" },
  healthLink: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 14,
    backgroundColor: theme.colors.backgroundAlt,
    marginBottom: 10,
  },
  healthLinkTxt: { color: theme.colors.cta, fontWeight: "800" },
  healthLinkSub: { marginTop: 6, color: theme.colors.textMuted, fontSize: 12 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md, marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.backgroundAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "900" },
  checkTxt: { flex: 1, color: theme.colors.text, fontWeight: "600" },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
});
