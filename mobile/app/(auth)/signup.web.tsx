import { useState } from "react";
import {
  View,
  Text,
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
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { parseISODateLocal, toISODateLocal, isValidISODateString } from "../../src/lib/isoDate";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { DatePickerField } from "../../src/components/DatePickerField";
import { buildAuthRedirectUrl } from "../../src/lib/authRedirect";
import {
  fetchCurrentElectronicReceiptsConsentVersion,
  syncPendingSignupConsent,
} from "../../src/lib/consent";
import { syncSignupProfileFromMetadata } from "../../src/lib/signupOnboarding";

const today = new Date();
const minDob = new Date(1900, 0, 1);
/** How long the button holds its success checkmark before navigating away. */
const SUCCESS_HOLD_MS = 550;

function getSignupErrorMessage(error: { message: string }): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return "This email is already in use. Sign in or use Forgot password.";
  }
  return error.message || "Signup failed. Please try again.";
}

export default function SignupScreen() {
  const { language, t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [dobText, setDobText] = useState("2000-01-15");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [healthConfirmed, setHealthConfirmed] = useState(false);
  const [receiptConsent, setReceiptConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const healthUrl = "https://tpz.link/gdtw8";

  function openHealthDeclaration() {
    // On web, open a new tab so the in-progress form isn't lost.
    if (typeof window !== "undefined") {
      window.open(healthUrl, "_blank", "noopener,noreferrer");
      return;
    }
    Linking.openURL(healthUrl);
  }

  async function onSignup() {
    setErrorMessage("");
    if (!email.trim() || password.length < 6 || !fullName.trim() || !phone.trim() || !address.trim() || !zipCode.trim()) {
      setErrorMessage(
        language === "he"
          ? "אנא מלאו אימייל, סיסמה (מינימום 6), שם מלא, טלפון, כתובת ומיקוד."
          : "Please fill in email, password (min 6), full name, phone, address, and zip code."
      );
      return;
    }
    if (!healthConfirmed) {
      setErrorMessage(
        language === "he"
          ? "אנא מלאו את הצהרת הבריאות ואשרו זאת לפני ההרשמה."
          : "Please complete the health declaration and confirm it before signing up."
      );
      return;
    }
    if (!receiptConsent) {
      setErrorMessage(
        language === "he"
          ? "יש לאשר את ההסכמה לקבלת קבלות אלקטרוניות."
          : "Please accept electronic receipt consent before signing up."
      );
      return;
    }
    if (!isValidISODateString(dobText.trim())) {
      setErrorMessage(language === "he" ? "בחרו תאריך לידה תקין." : "Please choose a valid date of birth.");
      return;
    }
    const dobFinal = parseISODateLocal(dobText.trim())!;
    if (dobFinal > today || dobFinal < minDob) {
      setErrorMessage(language === "he" ? "תאריך הלידה חייב להיות בין 1900 להיום." : "Date of birth must be between 1900 and today.");
      return;
    }
    const dobIso = toISODateLocal(dobFinal);
    setBusy(true);
    let consentVersion = 1;
    try {
      consentVersion = await fetchCurrentElectronicReceiptsConsentVersion();
    } catch {
      /* fallback version 1; sync RPC resolves current on login */
    }
    const emailRedirectTo = buildAuthRedirectUrl("/(auth)/confirm-email");
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo,
        data: {
          full_name: fullName.trim(),
          phone: phone.trim(),
          date_of_birth: dobIso,
          gender,
          address: address.trim(),
          zip_code: zipCode.trim(),
          health_declaration_confirmed: true,
          electronic_receipts_consent_pending: true,
          electronic_receipts_consent_version: consentVersion,
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
          address: address.trim(),
          zip_code: zipCode.trim(),
          gender,
          date_of_birth: dobIso,
          age: new Date().getFullYear() - dobFinal.getFullYear(),
          health_declaration_confirmed_at: new Date().toISOString(),
        })
        .eq("user_id", data.user.id);
      try {
        await syncSignupProfileFromMetadata();
        await syncPendingSignupConsent();
      } catch {
        /* AuthContext syncs on first login if email confirmation delayed session */
      }
    }
    setBusy(false);
    setSuccess(true);
    await new Promise((resolve) => setTimeout(resolve, SUCCESS_HOLD_MS));
    router.replace({
      pathname: "/(auth)/signup-success",
      params: { email: email.trim() },
    });
  }

  return (
    <KeyboardAvoidingView style={styles.keyboard}>
      <ScrollView style={styles.scrollRoot} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <LanguageToggleChip />
        <FadeSlideIn>
        <View style={styles.logoWrap}>
          <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
        </View>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("auth.createAccount")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.hint}>
          {t("auth.signupHint")}
        </AppText>
        {errorMessage ? (
          <View style={styles.errorBox}>
            <AppText variant="caption" isRTL={isRTL} style={styles.errorText}>
              {errorMessage}
            </AppText>
          </View>
        ) : null}

        <View style={styles.formCard}>
          <AppTextField variant="dark" label={t("auth.email")} isRTL={isRTL} placeholder={t("auth.email")} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={(v) => { setEmail(v); setErrorMessage(""); }} containerStyle={styles.field} />
          <AppTextField variant="dark" label={t("auth.passwordMin6")} isRTL={isRTL} placeholder={t("auth.passwordMin6")} secureTextEntry value={password} onChangeText={setPassword} containerStyle={styles.field} />
          <AppTextField variant="dark" label={t("profile.fullName")} isRTL={isRTL} placeholder={t("profile.fullName")} value={fullName} onChangeText={setFullName} containerStyle={styles.field} />
          <AppTextField variant="dark" label={t("profile.phone")} isRTL={isRTL} placeholder={t("profile.phone")} keyboardType="phone-pad" value={phone} onChangeText={setPhone} containerStyle={styles.field} />
          <AppTextField variant="dark" label={t("profile.address")} isRTL={isRTL} placeholder={t("profile.address")} value={address} onChangeText={setAddress} containerStyle={styles.field} />
          <AppTextField variant="dark" label={t("profile.zipCode")} isRTL={isRTL} placeholder={t("profile.zipCode")} keyboardType="number-pad" value={zipCode} onChangeText={setZipCode} containerStyle={styles.field} />
          <DatePickerField
            appearance="auth"
            label={t("profile.dob")}
            value={dobText}
            minimumDate={minDob}
            maximumDate={today}
            onChange={(v) => {
              setDobText(v);
              setErrorMessage("");
            }}
          />

          <Text style={[styles.fieldLabel, isRTL && styles.rtlText]}>{t("profile.gender")}</Text>
          <View style={styles.genderRow}>
            {(["male", "female"] as const).map((g) => (
              <Pressable
                key={g}
                style={({ pressed }) => [
                  styles.genderBtn,
                  gender === g && styles.genderBtnOn,
                  pressed && styles.genderBtnPressed,
                ]}
                onPress={() => setGender(g)}
                accessibilityRole="button"
                accessibilityState={{ selected: gender === g }}
              >
                <Text style={[styles.genderTxt, gender === g && styles.genderTxtOn]}>
                  {g === "male" ? t("profile.male") : t("profile.female")}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.sectionDivider} />
          <Text style={[styles.fieldLabel, isRTL && styles.rtlText]}>{t("health.required")}</Text>
          <Pressable
            style={({ pressed }) => [styles.healthLink, pressed && styles.linkPressed]}
            onPress={openHealthDeclaration}
          >
            <Text style={styles.healthLinkTxt}>{t("health.openForm")}</Text>
            <Text style={styles.healthLinkSub}>{healthUrl}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.checkRow, pressed && styles.linkPressed]}
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
            <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("health.confirmDone")}</Text>
          </Pressable>

          <View style={styles.sectionDivider} />
          <Text style={[styles.fieldLabel, isRTL && styles.rtlText]}>{t("consent.receiptsRequired")}</Text>
          <Pressable
            style={({ pressed }) => [styles.checkRow, pressed && styles.linkPressed]}
            onPress={() => {
              setReceiptConsent((v) => !v);
              setErrorMessage("");
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: receiptConsent }}
          >
            <View style={[styles.checkbox, receiptConsent && styles.checkboxOn]}>
              {receiptConsent ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("consent.receiptsConfirm")}</Text>
          </Pressable>
        </View>

        <PrimaryButton
          label={t("auth.signUp")}
          loadingLabel={t("common.loading")}
          loading={busy}
          success={success}
          onPress={onSignup}
        />
        <Pressable
          onPress={() => router.push("/(auth)/login")}
          style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.7 }]}
        >
          <AppText variant="caption" isRTL={isRTL} style={styles.linkTxt}>
            {t("auth.alreadyHaveAccount")}
          </AppText>
        </Pressable>
        </FadeSlideIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: {
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xl + theme.spacing.md,
    backgroundColor: theme.colors.backgroundAlt,
  },
  rtlText: { textAlign: "right" },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl },
  logo: { width: 200, height: 41 },
  title: {
    fontSize: 22,
    fontWeight: "800",
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
    letterSpacing: 0.2,
    lineHeight: 26,
  },
  hint: {
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 22,
    letterSpacing: 0.15,
  },
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  formCard: {
    marginBottom: theme.spacing.md,
  },
  field: { marginBottom: theme.spacing.sm },
  fieldLabel: {
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: theme.spacing.xs,
    marginTop: theme.spacing.sm,
    color: theme.colors.textSoft,
  },
  fieldLabelFirst: { marginTop: 0 },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: theme.spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    minHeight: 48,
    fontSize: 16,
    lineHeight: 22,
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.text,
  },
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  genderRow: { flexDirection: "row", gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  genderBtn: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
  },
  genderBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  genderBtnPressed: { opacity: 0.92 },
  genderTxt: { fontSize: 16, color: theme.colors.text, fontWeight: "600", letterSpacing: 0.15 },
  genderTxtOn: { color: theme.colors.ctaText, fontWeight: "700" },
  healthLink: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.surfaceElevated,
    marginBottom: theme.spacing.sm,
  },
  linkPressed: { opacity: 0.9 },
  healthLinkTxt: { color: theme.colors.cta, fontWeight: "800", fontSize: 15, letterSpacing: 0.15 },
  healthLinkSub: { marginTop: theme.spacing.xs, color: theme.colors.textMuted, fontSize: 12, lineHeight: 16 },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  checkTxt: { flex: 1, color: theme.colors.text, fontWeight: "600", fontSize: 15, lineHeight: 22 },
  linkBtn: { marginTop: theme.spacing.lg, alignSelf: "center", padding: theme.spacing.sm },
  linkTxt: { color: theme.colors.cta, fontWeight: "700" },
});
