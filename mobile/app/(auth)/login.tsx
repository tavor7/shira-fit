import { useEffect, useRef, useState } from "react";
import {
  View,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  Animated,
  type TextInput,
} from "react-native";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { AppTextField } from "../../src/components/AppTextField";
import { AppText } from "../../src/components/AppText";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { useReduceMotionRef } from "../../src/hooks/useReduceMotion";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { canRoleAccessWebPath, normalizeWebRedirectTarget, webPublicPathToExpoHref } from "../../src/lib/webLastRoute";

/** Loose client-side check; server remains authoritative. */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LEN = 254;
const MAX_PASSWORD_LEN = 128;
/** How long the success moment (button pop + logo pulse + form fade) holds before navigating away. */
const SUCCESS_HOLD_MS = 1500;

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
  const [success, setSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);
  const passwordRef = useRef<TextInput>(null);
  const logoScale = useRef(new Animated.Value(1)).current;
  const logoGlow = useRef(new Animated.Value(0)).current;
  const formProgress = useRef(new Animated.Value(1)).current;
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!success || reduceMotionRef.current) return;
    Animated.timing(formProgress, {
      toValue: 0,
      duration: 420,
      easing: theme.motion.easeIn,
      useNativeDriver: true,
    }).start();
    Animated.sequence([
      Animated.timing(logoScale, {
        toValue: 1.4,
        duration: 420,
        easing: theme.motion.springOvershoot,
        useNativeDriver: true,
      }),
      Animated.timing(logoScale, {
        toValue: 1.18,
        duration: 340,
        easing: theme.motion.easeOut,
        useNativeDriver: true,
      }),
    ]).start();
    Animated.timing(logoGlow, {
      toValue: 1,
      duration: 760,
      easing: theme.motion.easeOut,
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success]);

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
        if (Platform.OS === "ios" || Platform.OS === "android") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
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
        setSuccess(true);

        // Kick off the post-login redirect lookup alongside the success animation instead of
        // after it, so the hold isn't dead time — by the time the animation finishes, this has
        // usually already resolved. The session's own auth-state listener (AuthContext) is also
        // already loading the user's profile in the background from the moment sign-in resolved.
        const rawRedirect = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect;
        const target = Platform.OS === "web" ? normalizeWebRedirectTarget(rawRedirect) : null;
        const roleLookup: Promise<string | undefined> =
          target && data.session.user?.id
            ? Promise.resolve(
                supabase
                  .from("profiles")
                  .select("role")
                  .eq("user_id", data.session.user.id)
                  .maybeSingle()
              ).then(({ data: prof }) => (prof as { role?: string } | null)?.role)
            : Promise.resolve(undefined);
        const hold = new Promise<void>((resolve) => setTimeout(resolve, SUCCESS_HOLD_MS));

        const [role] = await Promise.all([roleLookup, hold]);
        if (!mountedRef.current) return;
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
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={styles.scrollRoot}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <FadeSlideIn>
          <View style={styles.logoWrap}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.logoGlow,
                {
                  opacity: logoGlow.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.55, 0] }),
                  transform: [
                    { scale: logoGlow.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.3] }) },
                  ],
                },
              ]}
            />
            <Animated.View style={{ transform: [{ scale: logoScale }] }}>
              <Image
                source={require("../../assets/logo.png")}
                style={styles.logo}
                resizeMode="contain"
                accessibilityLabel={t("a11y.appLogo")}
                accessibilityRole="image"
              />
            </Animated.View>
          </View>
        </FadeSlideIn>
        <FadeSlideIn delay={160}>
          <AppText variant="title" isRTL={isRTL} style={styles.title}>
            {t("auth.loginTitle")}
          </AppText>
        </FadeSlideIn>
        <FadeSlideIn delay={300}>
          <Animated.View
            pointerEvents={success ? "none" : "auto"}
            style={{
              opacity: formProgress,
              transform: [{ translateY: formProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
            }}
          >
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
          <View style={styles.formCard}>
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
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              blurOnSubmit={false}
            />
            <AppTextField
              ref={passwordRef}
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
              returnKeyType="go"
              onSubmitEditing={onLogin}
            />
          </View>
          <PrimaryButton
            label={t("auth.signIn")}
            loadingLabel={t("common.loading")}
            loading={busy}
            success={success}
            onPress={onLogin}
          />
          <View style={[styles.linksRow, isRTL && styles.linksRowRtl]}>
            <Pressable
              onPress={() => router.push("/(auth)/forgot-password")}
              style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.7 }]}
            >
              <AppText variant="caption" isRTL={isRTL} style={styles.linkTxt}>
                {t("auth.forgotPassword")}?
              </AppText>
            </Pressable>
            <AppText variant="caption" muted style={styles.linkDivider}>
              ·
            </AppText>
            <Pressable
              onPress={() => router.push("/(auth)/signup")}
              style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.7 }]}
            >
              <AppText variant="caption" isRTL={isRTL} style={styles.linkTxt}>
                {t("auth.createAccount")}
              </AppText>
            </Pressable>
          </View>
          <LanguageToggleChip />
          </Animated.View>
        </FadeSlideIn>
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
    justifyContent: "flex-start",
    padding: theme.spacing.lg,
    paddingTop: 72,
    paddingBottom: theme.spacing.xl + theme.spacing.md,
    backgroundColor: theme.colors.backgroundAlt,
  },
  rtlText: { textAlign: "right" },
  logoWrap: {
    alignItems: "center",
    marginBottom: 72,
  },
  logoGlow: {
    position: "absolute",
    top: -22,
    left: "50%",
    width: 220,
    height: 84,
    marginLeft: -110,
    borderRadius: 999,
    backgroundColor: theme.colors.cta,
  },
  logo: {
    width: 200,
    height: 41,
  },
  title: {
    textAlign: "center",
    marginBottom: theme.spacing.lg,
    color: theme.colors.alertSubject,
    fontWeight: "600",
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
  formCard: {
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  linksRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  linksRowRtl: { flexDirection: "row-reverse" },
  linkBtn: { padding: theme.spacing.sm },
  linkTxt: { color: theme.colors.cta, fontWeight: "700" },
  linkDivider: { fontWeight: "700" },
});
