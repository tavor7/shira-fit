import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../src/theme";
import { useI18n } from "../../src/context/I18nContext";
import { AppText } from "../../src/components/AppText";

type LegalLink = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  titleKey: string;
  descKey: string;
  href: "/legal/privacy" | "/legal/terms" | "/legal/accessibility";
};

const LINKS: LegalLink[] = [
  { key: "privacy", icon: "lock-closed-outline", titleKey: "legal.privacyLink", descKey: "legalHub.privacyDesc", href: "/legal/privacy" },
  { key: "terms", icon: "document-text-outline", titleKey: "legal.termsLink", descKey: "legalHub.termsDesc", href: "/legal/terms" },
  { key: "accessibility", icon: "accessibility-outline", titleKey: "legal.accessibilityLink", descKey: "legalHub.accessibilityDesc", href: "/legal/accessibility" },
];

export default function LegalHubScreen() {
  const { t, isRTL } = useI18n();

  return (
    <>
      <Stack.Screen options={{ title: t("legalHub.title") }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.container}>
        <AppText variant="display" isRTL={isRTL} style={styles.title}>
          {t("legalHub.title")}
        </AppText>
        <AppText variant="body" muted isRTL={isRTL} style={styles.subtitle}>
          {t("legalHub.subtitle")}
        </AppText>

        <View style={styles.list}>
          {LINKS.map((l) => (
            <Pressable
              key={l.key}
              onPress={() => router.push(l.href)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              accessibilityRole="button"
              accessibilityLabel={t(l.titleKey)}
            >
              <View style={[styles.iconWrap, isRTL && styles.iconWrapRtl]}>
                <Ionicons name={l.icon} size={20} color={theme.colors.cta} />
              </View>
              <View style={styles.cardText}>
                <AppText variant="title" isRTL={isRTL}>
                  {t(l.titleKey)}
                </AppText>
                <AppText variant="caption" muted isRTL={isRTL} style={styles.cardDesc}>
                  {t(l.descKey)}
                </AppText>
              </View>
              <Ionicons
                name={isRTL ? "chevron-back" : "chevron-forward"}
                size={18}
                color={theme.colors.textSoft}
              />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { padding: theme.spacing.lg, maxWidth: 600, width: "100%", alignSelf: "center" },
  title: { marginBottom: theme.spacing.xs },
  subtitle: { marginBottom: theme.spacing.lg, lineHeight: 21 },
  list: { gap: theme.spacing.sm },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    minHeight: 44,
  },
  cardPressed: { opacity: 0.85, backgroundColor: theme.colors.surfaceElevated },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapRtl: {},
  cardText: { flex: 1, gap: 2 },
  cardDesc: { lineHeight: 17 },
});
