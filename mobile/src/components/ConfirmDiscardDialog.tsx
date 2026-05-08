import { Modal, View, Text, Pressable, StyleSheet, useWindowDimensions, Platform } from "react-native";
import { theme } from "../theme";

type Props = {
  visible: boolean;
  title: string;
  message: string;
  cancelLabel: string;
  discardLabel: string;
  onCancel: () => void;
  onDiscard: () => void;
  isRTL?: boolean;
};

/**
 * On-brand confirmation for leaving with unsaved work (mobile + web).
 * Replaces system Alert / window.confirm for consistent Shira Fit visuals.
 */
export function ConfirmDiscardDialog({
  visible,
  title,
  message,
  cancelLabel,
  discardLabel,
  onCancel,
  onDiscard,
  isRTL,
}: Props) {
  const { width } = useWindowDimensions();
  const maxCard = Math.min(400, width - theme.spacing.lg * 2);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityRole="button" accessibilityLabel={cancelLabel}>
        <Pressable
          style={[styles.card, { maxWidth: maxCard }, Platform.OS === "web" ? styles.cardWeb : null]}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
        >
          <Text style={[styles.title, isRTL && styles.rtlText]} accessibilityRole="header">
            {title}
          </Text>
          <Text style={[styles.body, isRTL && styles.rtlText]}>{message}</Text>
          <View style={[styles.actions, isRTL && styles.actionsRtl]}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.btnSecondary, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={[styles.btnSecondaryTxt, isRTL && styles.rtlText]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onDiscard}
              style={({ pressed }) => [styles.btnDanger, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={[styles.btnDangerTxt, isRTL && styles.rtlText]}>{discardLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 8, 10, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.lg,
  },
  card: {
    width: "100%",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    padding: theme.spacing.lg,
  },
  /** RN Web only — elevation without relying on typed ViewStyle cursor/boxShadow quirks */
  cardWeb: {
    boxShadow: "0 16px 48px rgba(0, 0, 0, 0.45)",
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 24,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  body: {
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 22,
    letterSpacing: 0.15,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.lg,
  },
  rtlText: {
    textAlign: "right",
    writingDirection: "rtl",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    justifyContent: "flex-end",
  },
  actionsRtl: {
    flexDirection: "row-reverse",
    justifyContent: "flex-start",
  },
  btnSecondary: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 48,
    minWidth: 120,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSecondaryTxt: {
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.2,
  },
  btnDanger: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 48,
    minWidth: 120,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.45)",
    backgroundColor: "rgba(239, 68, 68, 0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnDangerTxt: {
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.error,
    letterSpacing: 0.2,
  },
  pressed: {
    opacity: 0.88,
  },
});
