import { StyleSheet } from "react-native";
import { theme } from "../theme";

/** Shared field styles for session / coach pricing screens. */
export const pricingScreenStyles = StyleSheet.create({
  rtl: { textAlign: "right", alignSelf: "stretch" },
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  embedded: { gap: theme.spacing.md },
  intro: {
    color: theme.colors.textMuted,
    lineHeight: 20,
    marginBottom: theme.spacing.sm,
    fontSize: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textMuted,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    fontWeight: "600",
    backgroundColor: theme.colors.backgroundAlt,
    color: theme.colors.text,
  },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: theme.colors.backgroundAlt,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerText: { fontSize: 15, fontWeight: "600", color: theme.colors.text },
  pickerPlaceholder: { fontSize: 15, fontWeight: "500", color: theme.colors.textSoft },
  cancelEdit: { alignItems: "center", paddingVertical: 6 },
  cancelEditTxt: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 13 },
  formActions: { gap: 8, marginTop: 4 },
});
