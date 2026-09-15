import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppText } from "./AppText";
import { fetchPublicBusinessInfo, fillLegalTokens, type PublicBusinessInfo } from "../lib/legalBusinessInfo";
import type { LegalDocument } from "../lib/legalContent";

type Props = {
  document: LegalDocument;
};

/** Shared renderer for the Terms of Use / Privacy Policy / Accessibility Statement screens. */
export function LegalDocumentScreen({ document }: Props) {
  const { language, isRTL, t } = useI18n();
  const [info, setInfo] = useState<PublicBusinessInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicBusinessInfo().then((res) => {
      if (!cancelled) setInfo(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fill = (text: string) =>
    info ? fillLegalTokens(text, info, language) : text.replace(/\{\{[A-Z_]+\}\}/g, "…");

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.container}
      accessibilityRole="none"
    >
      <AppText variant="display" isRTL={isRTL} style={styles.title} accessibilityRole="header">
        {document.title}
      </AppText>
      <AppText variant="caption" muted isRTL={isRTL} style={styles.updated}>
        {t("legal.lastUpdated")}: {document.lastUpdated}
      </AppText>

      {document.intro ? (
        <AppText variant="body" isRTL={isRTL} style={styles.intro}>
          {fill(document.intro)}
        </AppText>
      ) : null}

      {document.sections.map((section, i) => (
        <View key={i} style={styles.section}>
          <AppText variant="title" isRTL={isRTL} style={styles.heading} accessibilityRole="header">
            {section.heading}
          </AppText>
          <AppText variant="body" isRTL={isRTL} style={styles.body}>
            {fill(section.body)}
          </AppText>
        </View>
      ))}

      <View style={styles.footerSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: {
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  title: { marginBottom: theme.spacing.xs },
  updated: { marginBottom: theme.spacing.lg },
  intro: { marginBottom: theme.spacing.lg, lineHeight: 24 },
  section: { marginBottom: theme.spacing.lg },
  heading: { marginBottom: theme.spacing.xs },
  // `\n` line breaks in section body text render natively on iOS/Android; on web,
  // react-native-web needs an explicit `white-space` to avoid collapsing them.
  body: { lineHeight: 24, ...({ whiteSpace: "pre-line" } as Record<string, string>) },
  footerSpacer: { height: theme.spacing.lg },
});
