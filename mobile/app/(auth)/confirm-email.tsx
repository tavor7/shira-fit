import { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, ScrollView, Image, Platform } from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { syncPendingSignupConsent } from "../../src/lib/consent";
import { syncSignupProfileFromMetadata } from "../../src/lib/signupOnboarding";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";
import { FadeSlideIn } from "../../src/components/FadeSlideIn";
import { AppText } from "../../src/components/AppText";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { LoadingState } from "../../src/components/LoadingState";
import { AnimatedCheckMark } from "../../src/components/AnimatedCheckMark";
import { surface } from "../../src/theme/surfaces";

const REDIRECT_MS = 2800;

export default function ConfirmEmailScreen() {
  const { t, isRTL } = useI18n();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goLogin = useCallback(async () => {
    if (redirectTimer.current) {
      clearTimeout(redirectTimer.current);
      redirectTimer.current = null;
    }
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
    router.replace("/(auth)/login");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let hadAuthPayload = false;
      let verificationOk = false;
      try {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          const code = url.searchParams.get("code");
          const hash = window.location.hash || "";
          hadAuthPayload = !!(code || (hash && hash.includes("access_token")));

          if (code) {
            const { error } = await supabase.auth.exchangeCodeForSession(code);
            verificationOk = !error;
            url.searchParams.delete("code");
            const q = url.searchParams.toString();
            window.history.replaceState(null, "", url.pathname + (q ? `?${q}` : ""));
          } else if (hash.includes("access_token")) {
            const params = new URLSearchParams(hash.replace(/^#/, ""));
            const access_token = params.get("access_token");
            const refresh_token = params.get("refresh_token");
            if (access_token && refresh_token) {
              const { error } = await supabase.auth.setSession({ access_token, refresh_token });
              verificationOk = !error;
            }
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
          }
        }

        const { data } = await supabase.auth.getSession();
        const hasSession = !!data.session;

        if (cancelled) return;

        if (hadAuthPayload) {
          if (verificationOk && hasSession) {
            setState("ok");
            await logUserActivity("email_confirmed");
            try {
              await syncSignupProfileFromMetadata();
              await syncPendingSignupConsent();
            } catch {
              /* AuthContext retries on login */
            }
          } else {
            setState("error");
          }
        } else {
          setState("ok");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(REDIRECT_MS / 1000));

  useEffect(() => {
    if (state !== "ok") return;
    redirectTimer.current = setTimeout(() => {
      void goLogin();
    }, REDIRECT_MS);
    setSecondsLeft(Math.ceil(REDIRECT_MS / 1000));
    const tick = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
      clearInterval(tick);
    };
  }, [state, goLogin]);

  return (
    <ScrollView style={styles.scrollRoot} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <FadeSlideIn>
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel={t("a11y.appLogo")} />
      </View>

      <View style={styles.card}>
        {state === "loading" ? (
          <LoadingState label={t("common.loading")} isRTL={isRTL} />
        ) : (
          <>
            <View style={[styles.badge, state === "error" && styles.badgeErr]}>
              {state === "error" ? (
                <AppText variant="display" style={[styles.badgeText, styles.badgeTextErr]}>
                  {"!"}
                </AppText>
              ) : (
                <AnimatedCheckMark visible={state === "ok"} style={styles.badgeText} />
              )}
            </View>
            <AppText variant="display" isRTL={isRTL} style={styles.title}>
              {state === "ok" ? t("auth.confirmEmailVerified") : t("auth.confirmEmailFailed")}
            </AppText>
            <AppText variant="body" muted isRTL={isRTL} style={styles.lead}>
              {state === "ok"
                ? `${t("auth.confirmEmailRedirectLead")} (${secondsLeft})`
                : t("auth.confirmEmailErrorLead")}
            </AppText>
            <PrimaryButton label={t("auth.goToLogin")} onPress={goLogin} style={styles.btn} />
          </>
        )}
      </View>
      <LanguageToggleChip />
      </FadeSlideIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollRoot: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: {
    flexGrow: 1,
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    justifyContent: "flex-start",
    backgroundColor: theme.colors.backgroundAlt,
  },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.xl + theme.spacing.md },
  logo: { width: 200, height: 41 },
  card: {
    ...surface.hero,
    maxWidth: 480,
    alignSelf: "center",
    width: "100%",
    alignItems: "center",
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.successBg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: theme.spacing.lg,
  },
  badgeErr: { backgroundColor: theme.colors.errorBg },
  badgeText: { color: theme.colors.success, fontSize: 22, fontWeight: "800" },
  badgeTextErr: { color: theme.colors.error },
  title: { textAlign: "center", marginBottom: theme.spacing.sm },
  lead: { textAlign: "center", marginBottom: theme.spacing.lg },
  btn: { alignSelf: "stretch", marginTop: 0 },
});
