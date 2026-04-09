import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Image, Platform } from "react-native";
import { router } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { LanguageToggleChip } from "../../src/components/LanguageToggleChip";

/**
 * Landing page for Supabase email-confirmation links.
 * Handles both PKCE (?code=...) and legacy hash tokens (#access_token=...).
 * Shows a clear confirmation message and a link back to login.
 */
export default function ConfirmEmailScreen() {
  const { language, t, isRTL } = useI18n();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          const code = url.searchParams.get("code");
          if (code) {
            await supabase.auth.exchangeCodeForSession(code);
            url.searchParams.delete("code");
            window.history.replaceState(null, "", url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : ""));
          } else {
            const hash = window.location.hash;
            if (hash && hash.includes("access_token")) {
              const params = new URLSearchParams(hash.replace(/^#/, ""));
              const access_token = params.get("access_token");
              const refresh_token = params.get("refresh_token");
              if (access_token && refresh_token) {
                await supabase.auth.setSession({ access_token, refresh_token });
                window.history.replaceState(null, "", window.location.pathname + window.location.search);
              }
            }
          }
        }

        const { data } = await supabase.auth.getSession();
        // Even if session isn't present (older links / already confirmed),
        // the user still expects a friendly success landing page.
        if (!cancelled) setState(data.session ? "ok" : "ok");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function goLogin() {
    // Don't keep a confirmation-session around; force normal login flow.
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
    router.replace("/(auth)/login");
  }

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
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{state === "ok" ? "✓" : "!"}</Text>
            </View>
            <Text style={[styles.title, isRTL && { textAlign: "right" }]}>
              {state === "ok"
                ? language === "he"
                  ? "האימייל אומת"
                  : "Email confirmed"
                : language === "he"
                  ? "האימות נכשל"
                  : "Confirmation failed"}
            </Text>
            <Text style={[styles.lead, isRTL && { textAlign: "right" }]}>
              {state === "ok"
                ? language === "he"
                  ? "אפשר להתחבר כעת לחשבון שלך."
                  : "You can now sign in to your account."
                : language === "he"
                  ? "הקישור לא תקין או שפג תוקפו. נסו לשלוח מחדש מההרשמה/התחברות."
                  : "This link is invalid or expired. Try requesting a new confirmation link."}
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
  badgeText: { fontSize: 28, color: theme.colors.success, fontWeight: "900" },
  title: { fontSize: 24, fontWeight: "900", textAlign: "center", marginBottom: 12, color: theme.colors.text },
  lead: { fontSize: 16, lineHeight: 24, color: theme.colors.textMuted, textAlign: "center", marginBottom: 20 },
  note: { fontSize: 13, color: theme.colors.textSoft, textAlign: "center", marginTop: 12 },
  btn: { backgroundColor: theme.colors.cta, paddingVertical: 14, paddingHorizontal: 16, borderRadius: theme.radius.md, alignItems: "center", width: "100%" },
  btnPressed: { opacity: 0.9 },
  btnText: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 16, letterSpacing: 0.2 },
});

