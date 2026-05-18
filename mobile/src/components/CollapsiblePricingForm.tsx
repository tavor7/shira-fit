import type { ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";

type Props = {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  summary?: string;
  isRTL?: boolean;
  /** `inline` nests inside PricingSection without an extra card chrome. */
  variant?: "card" | "inline";
  children: ReactNode;
};

export function CollapsiblePricingForm({
  title,
  expanded,
  onToggle,
  summary,
  isRTL,
  variant = "card",
  children,
}: Props) {
  const inline = variant === "inline";

  return (
    <View style={inline ? styles.inlineRoot : styles.card}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [
          styles.header,
          isRTL && styles.headerRtl,
          inline && styles.headerInline,
          pressed && { opacity: 0.9 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={summary ? `${title}. ${summary}` : title}
      >
        <View style={[styles.titleRow, isRTL && styles.titleRowRtl]}>
          <View style={[styles.plusWrap, expanded && styles.plusWrapExpanded]}>
            <Text style={[styles.plus, expanded && styles.plusExpanded]}>{expanded ? "−" : "+"}</Text>
          </View>
          <Text style={[inline ? styles.titleInline : styles.title, isRTL && styles.rtl]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={[styles.headerEnd, isRTL && styles.headerEndRtl]}>
          {!expanded && summary ? (
            <Text style={[styles.summary, isRTL && styles.rtl]} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
          <Text style={styles.chevron}>{expanded ? "▴" : "▾"}</Text>
        </View>
      </Pressable>
      {expanded ? <View style={[styles.body, inline && styles.bodyInline]}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  inlineRoot: {},
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minHeight: 32,
  },
  headerInline: {
    paddingVertical: 4,
  },
  headerRtl: { flexDirection: "row-reverse" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 },
  titleRowRtl: { flexDirection: "row-reverse" },
  plusWrap: {
    width: 24,
    height: 24,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  plusWrapExpanded: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  plus: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  plusExpanded: { color: theme.colors.ctaText },
  title: { fontWeight: "900", fontSize: 15, color: theme.colors.text, flexShrink: 1 },
  titleInline: { fontWeight: "800", fontSize: 14, color: theme.colors.textMuted, flexShrink: 1 },
  headerEnd: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    flexShrink: 0,
    maxWidth: "55%",
  },
  headerEndRtl: { flexDirection: "row-reverse" },
  summary: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, flexShrink: 1 },
  chevron: { fontSize: 11, fontWeight: "800", color: theme.colors.textSoft },
  body: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    gap: 10,
  },
  bodyInline: {
    marginTop: 0,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 0,
  },
  rtl: { textAlign: "right" },
});
