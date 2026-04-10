import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Image, Platform } from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { logUserActivity } from "../../src/lib/logUserActivity";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

const REDIRECT_MS = 2800;

/**
 * Landing page for Supabase email-confirmation links.
 * Handles PKCE (?code=...) and legacy hash tokens (#access_token=...).
 */
export default function ConfirmEmailScreen() {
  const { language, t, isRTL } = useI18n();
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

  useEffect(() => {
    if (state !== "ok") return;
    redirectTimer.current = setTimeout(() => {
      void goLogin();
    }, REDIRECT_MS);
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, [state, goLogin]);

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <LanguageToggleChip />
      <View style={styles.logoWrap}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />
      </View>

      <View style={styles.card}>
        {state === "loading" ? (
          <>
            <ActivityIndicator size="large" color={theme.colors.cta} />
            <Text style={[styles.note, isRTL && { textAlign: "right" }]}>{t("common.loading")}</Text>
          </>
        ) : (
          <>
            <View style={[styles.badge, state === "error" && styles.badgeErr]}>
                           <Text style={[styles.badgeText, state === "error" && styles.badgeTextErr]}>{state === "ok" ? "\u2713" : "!"}</Text>
            </View>
            <Text style={[styles.title, isRTL && { textAlign: "right" }]}>
              {state === "ok"
                ? language === "he"
                  ? "האימייל אומת"
                  : "Email verified"
                : language === "he"
                  ? "האימות נכשל"
                  : "Verification failed"}
            </Text>
            <Text style={[styles.lead, isRTL && { textAlign: "right" }]}>
              {state === "ok"
                ? language === "he"
                  ? `מעבירים אותך להתחברות בעוד כמה שניות, או לחצו למטה.`
                  : `Redirecting to sign in in a few seconds, or tap below.`
                : language === "he"
                  ? "הקישור לא תקין או שפג תוקפו. נסו שוב מהמייל או מההרשמה."
                  : "This link is invalid or expired. Open the latest email from us or sign up again."}
            </Text>

            <Pressable style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]} onPress={goLogin}>
              <Text style={styles.btnText}>{language === "he" ? "להתחברות" : "Go to login"}</Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: theme.spacing.lg, justifyContent: "center", backgroundColor: theme.colors.backgroundAlt },
  logoWrap: { alignItems: "center", marginBottom: theme.spacing.sm },
  logo: { width: 120, height: 120 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 28,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
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
    marginBottom: 20,
  },
  badgeErr: { backgroundColor: theme.colors.errorBg },
  badgeText: { fontSize: 28, color: theme.colors.success, fontWeight: "900" },
  badgeTextErr: { color: theme.colors.error },
  title: { fontSize: 24, fontWeight: "900", textAlign: "center", marginBottom: 12, color: theme.colors.text },
  lead: { fontSize: 16, lineHeight: 24, color: theme.colors.textMuted, textAlign: "center", marginBottom: 20 },
  note: { fontSize: 13, color: theme.colors.textSoft, textAlign: "center", marginTop: 12 },
  btn: { backgroundColor: theme.colors.cta, paddingVertical: 14, paddingHorizontal: 16, borderRadius: theme.radius.md, alignItems: "center", width: "100%" },
  btnPressed: { opacity: 0.9 },
  btnText: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 16, letterSpacing: 0.2 },
});
