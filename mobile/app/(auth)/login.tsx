import { useEffect, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ActionButton } from "../../src/components/ActionButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { canRoleAccessWebPath, normalizeWebRedirectTarget, webPublicPathToExpoHref } from "../../src/lib/webLastRoute";

export const options = { headerShown: false };

/** Loose client-side check; server remains authoritative. */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LEN = 254;
const MAX_PASSWORD_LEN = 128;

type ClassifiedLoginError =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "rate_limited"
  | "network"
  | "generic";

function classifyLoginError(error: { message: string }): ClassifiedLoginError {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("invalid login credentials") || msg.includes("invalid_credentials")) {
    return "invalid_credentials";
  }
  if (msg.includes("email not confirmed")) {
    return "email_not_confirmed";
  }
  if (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("too_many") ||
    msg.includes("over_request_rate")
  ) {
    return "rate_limited";
  }
  if (
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("internet") ||
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused")
  ) {
    return "network";
  }
  return "generic";
}

export default function LoginScreen() {
  const params = useLocalSearchParams<{ redirect?: string | string[] }>();
  const { t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function onLogin() {
    if (busy) return;
    setErrorMessage("");
    const emailTrim = email.trim();
    if (!emailTrim) {
      setErrorMessage(t("auth.loginErrorEmailRequired"));
      return;
    }
    if (!EMAIL_LIKE.test(emailTrim)) {
      setErrorMessage(t("auth.loginErrorInvalidEmail"));
      return;
    }
    if (!password) {
      setErrorMessage(t("auth.loginErrorPasswordRequired"));
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: emailTrim,
        password,
      });
      if (!mountedRef.current) return;
      if (error) {
        const kind = classifyLoginError(error);
        if (kind === "invalid_credentials") {
          setErrorMessage(t("auth.loginErrorBadCreds"));
        } else if (kind === "email_not_confirmed") {
          setErrorMessage(t("auth.loginErrorUnconfirmed"));
        } else if (kind === "rate_limited") {
          setErrorMessage(t("auth.loginErrorRateLimited"));
        } else if (kind === "network") {
          setErrorMessage(t("auth.loginErrorNetwork"));
        } else {
          setErrorMessage(t("auth.loginErrorGeneric"));
        }
        return;
      }
      if (data.session) {
        void logUserActivity("auth_login");
        const rawRedirect = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect;
        const target = Platform.OS === "web" ? normalizeWebRedirectTarget(rawRedirect) : null;
        let role: string | undefined;
        if (target && data.session.user?.id) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("role")
            .eq("user_id", data.session.user.id)
            .maybeSingle();
          role = (prof as { role?: string } | null)?.role;
        }
        if (Platform.OS === "web" && target && role && canRoleAccessWebPath(role, target)) {
          router.replace(webPublicPathToExpoHref(target));
        } else {
          router.replace("/");
        }
      } else {
        setErrorMessage(t("auth.loginErrorIncomplete"));
      }
    } catch {
      if (!mountedRef.current) return;
      setErrorMessage(t("auth.loginErrorNetwork"));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={styles.scrollRoot}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <LanguageToggleChip />
        <View style={styles.logoWrap}>
          <Image
            source={require("../../assets/logo.png")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel={t("a11y.appLogo")}
            accessibilityRole="image"
          />
        </View>
        <AppText variant="body" muted isRTL={isRTL} style={styles.sub}>
          {t("auth.loginSubtitle")}
        </AppText>
        {errorMessage ? (
          <View
            style={styles.errorBox}
            accessibilityRole="alert"
            accessibilityLabel={t("a11y.loginError")}
            accessibilityLiveRegion="polite"
          >
            <AppText variant="caption" isRTL={isRTL} style={styles.errorText}>
              {errorMessage}
            </AppText>
          </View>
        ) : null}
        <AppTextField
          variant="dark"
          isRTL={isRTL}
          placeholder={t("auth.email")}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          value={email}
          maxLength={MAX_EMAIL_LEN}
          onChangeText={(txt) => {
            setEmail(txt);
            setErrorMessage("");
          }}
          accessibilityLabel={t("auth.email")}
          error={!!errorMessage}
          containerStyle={styles.field}
        />
        <AppTextField
          variant="dark"
          isRTL={isRTL}
          placeholder={t("auth.password")}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          value={password}
          maxLength={MAX_PASSWORD_LEN}
          onChangeText={(txt) => {
            setPassword(txt);
            setErrorMessage("");
          }}
          accessibilityLabel={t("auth.password")}
          error={!!errorMessage}
          containerStyle={styles.field}
        />
        <PrimaryButton
          label={t("auth.signIn")}
          loadingLabel={t("common.loading")}
          loading={busy}
          onPress={onLogin}
        />
        <ActionButton label={t("auth.forgotPassword") + "?"} onPress={() => router.push("/(auth)/forgot-password")} style={styles.navBtn} />
        <ActionButton label={t("auth.createAccount")} onPress={() => router.push("/(auth)/signup")} style={styles.navBtn} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
    backgroundColor: theme.colors.backgroundAlt,
  },
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xl + theme.spacing.md,
    backgroundColor: theme.colors.backgroundAlt,
  },
  rtlText: { textAlign: "right" },
  logoWrap: {
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  logo: {
    width: 200,
    height: 200,
  },
  sub: {
    textAlign: "center",
    marginBottom: theme.spacing.lg,
  },
  errorBox: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.error },
  field: { marginBottom: theme.spacing.sm },
  navBtn: { marginTop: theme.spacing.md, alignSelf: "center", width: "100%" },
});
