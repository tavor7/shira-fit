import { StyleSheet } from "react-native";
import { theme } from "../theme";

export function sessionFormIsCompact(width: number) {
  return width < 380;
}

export const sessionFormStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { flexGrow: 1, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl },

  /** Even vertical gap between form section cards (use on a column wrapper). */
  sections: {
    gap: theme.spacing.md,
  },

  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },

  toggleStack: {
    gap: 10,
  },
  /** Primary actions at the bottom of session forms (save / cancel). */
  actionsStack: {
    gap: theme.spacing.sm,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: theme.colors.text,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  /** Softer section label (create/edit forms). */
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
    letterSpacing: 0.2,
    marginBottom: theme.spacing.sm,
  },
  sectionHint: {
    marginTop: -4,
    marginBottom: theme.spacing.sm,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 17,
  },
  sectionHintRtl: { textAlign: "right" },

  row: { flexDirection: "row", gap: 10, alignItems: "stretch" },
  rowStack: { flexDirection: "column" },
  // Critical: allow columns to shrink; prevents overflow/overlap.
  col: { flex: 1, flexBasis: 0, minWidth: 0 },

  label: { marginBottom: 6, fontWeight: "700", color: theme.colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  labelRtl: { textAlign: "right" },

  control: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  controlText: { fontSize: 16, fontWeight: "700", color: theme.colors.text },
  controlPlaceholder: { fontSize: 16, fontWeight: "700", color: theme.colors.textSoft },
  controlInput: { fontSize: 16, fontWeight: "700", color: theme.colors.text },

  toggle: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: "center",
  },
  toggleText: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  toggleSub: { marginTop: 4, color: theme.colors.textSoft, fontWeight: "700", fontSize: 12, lineHeight: 16 },
  error: { marginTop: 8, color: theme.colors.error, fontWeight: "800" },
});

