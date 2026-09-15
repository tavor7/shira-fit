import { Platform, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppText } from "./AppText";

type Props = {
  style?: object;
  /** Web only: pin to the bottom of the viewport as a persistent bar, instead of sitting inline in the page flow. */
  fixed?: boolean;
};

/** Compact Privacy / Terms / Accessibility links row. Global web footer + any screen that wants it inline. */
export function LegalFooterLinks({ style, fixed }: Props) {
  const { t, isRTL } = useI18n();
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, theme.spacing.sm);
  const isFixedWeb = fixed && Platform.OS === "web";

  const links: { key: string; label: string; href: "/legal/privacy" | "/legal/terms" | "/legal/accessibility" }[] = [
    { key: "privacy", label: t("legal.privacyLink"), href: "/legal/privacy" },
    { key: "terms", label: t("legal.termsLink"), href: "/legal/terms" },
    { key: "accessibility", label: t("legal.accessibilityLink"), href: "/legal/accessibility" },
  ];

  return (
    <View
      style={[
        isFixedWeb ? styles.fixedBar : undefined,
        isFixedWeb && { paddingBottom: bottomPad },
        styles.row,
        isRTL && styles.rowRtl,
        !isFixedWeb && Platform.OS === "web" && styles.webPad,
        style,
      ]}
    >
      {links.map((l, i) => (
        <View key={l.key} style={styles.item}>
          {i > 0 ? <AppText variant="caption" muted style={styles.dot}>·</AppText> : null}
          <Pressable onPress={() => router.push(l.href)} hitSlop={8} accessibilityRole="link">
            <AppText variant="caption" style={styles.link}>
              {l.label}
            </AppText>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fixedBar: {
    position: "fixed" as "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9400,
    backgroundColor: theme.colors.backgroundAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    paddingTop: theme.spacing.sm,
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center" },
  rowRtl: { flexDirection: "row-reverse" },
  webPad: { paddingTop: theme.spacing.sm },
  item: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs },
  dot: { marginHorizontal: 6 },
  link: { color: theme.colors.textMuted, fontWeight: "600", textDecorationLine: "underline" },
});
