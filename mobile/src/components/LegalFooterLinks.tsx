import { Platform, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppText } from "./AppText";

/** Compact Privacy / Terms / Accessibility links row — sits inline wherever it's placed. */
export function LegalFooterLinks({ style }: { style?: object }) {
  const { t, isRTL } = useI18n();

  const links: { key: string; label: string; href: "/legal/privacy" | "/legal/terms" | "/legal/accessibility" }[] = [
    { key: "privacy", label: t("legal.privacyLink"), href: "/legal/privacy" },
    { key: "terms", label: t("legal.termsLink"), href: "/legal/terms" },
    { key: "accessibility", label: t("legal.accessibilityLink"), href: "/legal/accessibility" },
  ];

  return (
    <View style={[styles.row, isRTL && styles.rowRtl, Platform.OS === "web" && styles.webPad, style]}>
      {links.map((l, i) => (
        <Pressable
          key={l.key}
          onPress={() => router.push(l.href)}
          hitSlop={8}
          style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
          accessibilityRole="link"
        >
          <AppText variant="caption" style={styles.link}>
            {l.label}
            {i < links.length - 1 ? <AppText variant="caption" style={styles.dot}> {"·"}</AppText> : null}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center" },
  rowRtl: { flexDirection: "row-reverse" },
  webPad: { paddingVertical: theme.spacing.sm },
  item: { paddingVertical: 6, paddingHorizontal: 4, minHeight: 32, justifyContent: "center" },
  itemPressed: { opacity: 0.7 },
  link: { color: theme.colors.cta, fontWeight: "700" },
  dot: { color: theme.colors.textSoft, fontWeight: "700" },
});
