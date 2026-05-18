import type { ReactNode } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { theme } from "../theme";

type Props = {
  title: string;
  hint?: string;
  isRTL?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  count?: number;
  children?: ReactNode;
  footer?: ReactNode;
};

export function PricingSection({
  title,
  hint,
  isRTL,
  loading,
  emptyMessage,
  count,
  children,
  footer,
}: Props) {
  const hasList = !loading && count !== undefined && count > 0;

  return (
    <View style={styles.section}>
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{title}</Text>
        {count !== undefined && count > 0 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countTxt}>{count}</Text>
          </View>
        ) : null}
      </View>
      {hint ? <Text style={[styles.hint, isRTL && styles.rtl]}>{hint}</Text> : null}

      {loading ? (
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} accessibilityLabel="Loading" />
      ) : hasList ? (
        <View style={styles.list}>{children}</View>
      ) : emptyMessage ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{emptyMessage}</Text>
      ) : null}

      {footer ? <View style={[styles.footer, hasList || loading ? styles.footerBorder : null]}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xs,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.15,
  },
  countBadge: {
    minWidth: 26,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  countTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  hint: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  rtl: { textAlign: "right" },
  loader: { paddingVertical: theme.spacing.lg },
  empty: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    fontSize: 14,
    color: theme.colors.textSoft,
    lineHeight: 20,
  },
  list: {
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
    gap: 6,
  },
  footer: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  footerBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    marginTop: theme.spacing.xs,
  },
});
