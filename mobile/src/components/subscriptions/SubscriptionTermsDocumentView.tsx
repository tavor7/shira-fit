import { type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { theme } from "../../theme";
import { rowFlipFor } from "../../lib/layoutDirection";
import { AppText } from "../AppText";
import { AnimatedCheckMark } from "../AnimatedCheckMark";
import { PrimaryButton } from "../PrimaryButton";

type Props = {
  title: string;
  body: string;
  version: number | string;
  isRTL: boolean;
  t: (key: string) => string;
  checked: boolean;
  onToggle: () => void;
  onAccept: () => void;
  accepting?: boolean;
  error?: string;
  /** Rendered above the title (language chip / log out on the athlete screen, a preview banner for managers). */
  header?: ReactNode;
  /** Manager preview: the same layout, but nothing can be accepted. */
  previewOnly?: boolean;
};

/**
 * The subscription-terms document exactly as athletes see it: title, intro, version, scrollable text, the
 * unchecked-by-default consent checkbox and the Accept button. Shared by the mandatory athlete screen and the manager
 * preview so a preview always matches the real screen.
 */
export function SubscriptionTermsDocumentView({
  title,
  body,
  version,
  isRTL,
  t,
  checked,
  onToggle,
  onAccept,
  accepting,
  error,
  header,
  previewOnly,
}: Props) {
  return (
    <>
      {header}
      <AppText variant="headline" isRTL={isRTL} accessibilityRole="header" style={styles.title}>
        {title}
      </AppText>
      <AppText variant="caption" muted isRTL={isRTL} style={styles.intro}>
        {t("subscriptionTerms.gateIntro")}
      </AppText>
      <AppText variant="caption" muted isRTL={isRTL} style={styles.version}>
        {t("subscriptionTerms.version").replace("{v}", String(version))}
      </AppText>

      <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator>
        <AppText variant="body" isRTL={isRTL} style={styles.body}>
          {body}
        </AppText>
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.checkRow, rowFlipFor(isRTL) && styles.checkRowRtl, pressed && { opacity: 0.9 }]}
        onPress={onToggle}
        disabled={previewOnly}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: !!previewOnly }}
        aria-checked={checked}
        accessibilityLabel={t("subscriptionTerms.checkbox")}
      >
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          <AnimatedCheckMark visible={checked} style={styles.checkboxMark} />
        </View>
        <AppText variant="body" isRTL={isRTL} style={styles.checkTxt}>
          {t("subscriptionTerms.checkbox")}
        </AppText>
      </Pressable>

      {error ? (
        <AppText variant="caption" isRTL={isRTL} style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <PrimaryButton
        label={t("subscriptionTerms.accept")}
        loadingLabel={t("common.loading")}
        loading={accepting}
        disabled={previewOnly || !checked}
        onPress={onAccept}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 2 },
  intro: { marginBottom: 2, lineHeight: 18 },
  version: { marginBottom: theme.spacing.sm },
  bodyScroll: {
    flexShrink: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    marginBottom: theme.spacing.md,
  },
  bodyContent: { padding: theme.spacing.md },
  body: { lineHeight: 22 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, minHeight: 44, marginBottom: theme.spacing.sm },
  checkRowRtl: { flexDirection: "row-reverse" },
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
  checkboxMark: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 13 },
  checkTxt: { flex: 1 },
  error: { color: theme.colors.error, marginBottom: theme.spacing.sm },
});
