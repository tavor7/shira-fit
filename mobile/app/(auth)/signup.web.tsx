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
import { AnimatedCheckMark } from "../../src/components/AnimatedCheckMark";
import { buildAuthRedirectUrl } from "../../src/lib/authRedirect";
import {
  fetchCurrentElectronicReceiptsConsentVersion,
  syncPendingSignupConsent,
  syncPendingSignupLegalConsents,
} from "../../src/lib/consent";
import { LEGAL_VERSIONS } from "../../src/lib/legalContent";
import { syncSignupProfileFromMetadata } from "../../src/lib/signupOnboarding";

const today = new Date();
const minDob = new Date(1900, 0, 1);
/** How long the button holds its success checkmark before navigating away. */
const SUCCESS_HOLD_MS = 550;

function emailInUseMessage(language: string): string {
  return language === "he"
    ? "האימייל הזה כבר בשימוש. התחברו או השתמשו ב\"שכחתי סיסמה\"."
    : "This email is already in use. Sign in or use Forgot password.";
}

function getSignupErrorMessage(error: { message: string }, language: string): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already in use")) {
    return emailInUseMessage(language);
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
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
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
    if (!termsAccepted || !privacyAccepted) {
      setErrorMessage(
        language === "he"
          ? "יש לאשר את תקנון האתר ואת מדיניות הפרטיות כדי להירשם."
          : "Please accept the Terms of Use and Privacy Policy to sign up."
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
          legal_consent_pending: {
            terms_of_service: { version: LEGAL_VERSIONS.termsOfService, status: "accepted" },
            privacy_policy: { version: LEGAL_VERSIONS.privacyPolicy, status: "accepted" },
            marketing_communications: {
              version: LEGAL_VERSIONS.marketingCommunications,
              status: marketingOptIn ? "accepted" : "declined",
            },
          },
        },
      },
    });
    if (error) {
      setBusy(false);
      setErrorMessage(getSignupErrorMessage(error, language));
      return;
    }
    // Supabase returns a fake "success" (no error) when the email already belongs to an
    // existing account — usually one still awaiting confirmation — to avoid leaking which
    // emails are registered. It just resends that account's confirmation email instead of
    // creating a new one. Detect it via the documented empty-identities signal so we don't
    // overwrite that account's profile with this submission's data.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      setBusy(false);
      setErrorMessage(emailInUseMessage(language));
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
        await syncPendingSignupLegalConsents();
      } catch {
        /* AuthContext syncs on first login if email confirmation delayed the session */
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
          <Text style={[styles.healthDisclosureTxt, isRTL && styles.rtlText]}>
            {t("health.tepezDisclosure")}
          </Text>
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
              <AnimatedCheckMark visible={healthConfirmed} style={styles.checkboxMark} />
            </View>
            <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("health.confirmDone")}</Text>
          </Pressable>

          <View style={styles.sectionDivider} />
          <View style={styles.legalBox}>
            <View style={styles.legalBoxRow}>
              <Pressable
                style={({ pressed }) => [styles.legalBoxCheckArea, pressed && styles.linkPressed]}
                onPress={() => {
                  setTermsAccepted((v) => !v);
                  setErrorMessage("");
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: termsAccepted }}
              >
                <View style={[styles.checkbox, termsAccepted && styles.checkboxOn]}>
                  <AnimatedCheckMark visible={termsAccepted} style={styles.checkboxMark} />
                </View>
                <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("consent.termsConfirm")}</Text>
              </Pressable>
              <Pressable onPress={() => router.push("/legal/terms")} hitSlop={8}>
                <Text style={styles.legalViewLink}>{t("consent.viewDocument")}</Text>
              </Pressable>
            </View>

            <View style={styles.legalBoxDivider} />

            <View style={styles.legalBoxRow}>
              <Pressable
                style={({ pressed }) => [styles.legalBoxCheckArea, pressed && styles.linkPressed]}
                onPress={() => {
                  setPrivacyAccepted((v) => !v);
                  setErrorMessage("");
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: privacyAccepted }}
              >
                <View style={[styles.checkbox, privacyAccepted && styles.checkboxOn]}>
                  <AnimatedCheckMark visible={privacyAccepted} style={styles.checkboxMark} />
                </View>
                <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("consent.privacyConfirm")}</Text>
              </Pressable>
              <Pressable onPress={() => router.push("/legal/privacy")} hitSlop={8}>
                <Text style={styles.legalViewLink}>{t("consent.viewDocument")}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.sectionDivider} />
          <Text style={[styles.fieldLabel, isRTL && styles.rtlText]}>{t("consent.marketingOptIn")}</Text>
          <Pressable
            style={({ pressed }) => [styles.checkRow, pressed && styles.linkPressed]}
            onPress={() => {
              setMarketingOptIn((v) => !v);
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: marketingOptIn }}
          >
            <View style={[styles.checkbox, marketingOptIn && styles.checkboxOn]}>
              <AnimatedCheckMark visible={marketingOptIn} style={styles.checkboxMark} />
            </View>
            <Text style={[styles.checkTxt, isRTL && styles.rtlText]}>{t("consent.marketingConfirm")}</Text>
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
        <LanguageToggleChip />
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
  healthDisclosureTxt: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  legalBox: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: theme.spacing.sm,
  },
  legalBoxRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  legalBoxCheckArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  legalBoxDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
  },
  legalViewLink: {
    color: theme.colors.cta,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.2,
  },
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
