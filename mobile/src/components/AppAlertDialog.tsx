import { Modal, View, Text, Pressable, StyleSheet, useWindowDimensions, Platform } from "react-native";
import { theme } from "../theme";

export type AppAlertActionVariant = "primary" | "secondary" | "danger";

export type AppAlertAction = {
  label: string;
  variant: AppAlertActionVariant;
  onPress: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  message: string;
  actions: AppAlertAction[];
  /** Android back / optional backdrop behavior */
  onRequestClose: () => void;
  isRTL?: boolean;
};

/**
 * Generic on-brand alert / confirm (mobile + web). Same visual language as {@link ConfirmDiscardDialog}.
 */
export function AppAlertDialog({ visible, title, message, actions, onRequestClose, isRTL }: Props) {
  const { width } = useWindowDimensions();
  const maxCard = Math.min(400, width - theme.spacing.lg * 2);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent>
      <Pressable
        style={styles.backdrop}
        onPress={onRequestClose}
        accessibilityRole="button"
        accessibilityLabel={actions[0]?.label}
      >
        <Pressable
          style={[styles.card, { maxWidth: maxCard }, Platform.OS === "web" ? styles.cardWeb : null]}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
        >
          {title ? (
            <Text style={[styles.title, isRTL && styles.rtlText]} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          <Text style={[styles.body, isRTL && styles.rtlText]}>{message}</Text>
          <View style={[styles.actions, isRTL && styles.actionsRtl]}>
            {actions.map((a, i) => {
              const key = `${a.label}-${i}`;
              if (a.variant === "danger") {
                return (
                  <Pressable
                    key={key}
                    onPress={a.onPress}
                    style={({ pressed }) => [styles.btnDanger, pressed && styles.pressed]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.btnDangerTxt, isRTL && styles.rtlText]}>{a.label}</Text>
                  </Pressable>
                );
              }
              if (a.variant === "primary") {
                return (
                  <Pressable
                    key={key}
                    onPress={a.onPress}
                    style={({ pressed }) => [styles.btnPrimary, pressed && styles.pressed]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.btnPrimaryTxt, isRTL && styles.rtlText]}>{a.label}</Text>
                  </Pressable>
                );
              }
              return (
                <Pressable
                  key={key}
                  onPress={a.onPress}
                  style={({ pressed }) => [styles.btnSecondary, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.btnSecondaryTxt, isRTL && styles.rtlText]}>{a.label}</Text>
                </Pressable>
              );
            })}
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
  btnPrimary: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 48,
    minWidth: 120,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryTxt: {
    fontSize: 15,
    fontWeight: "800",
    color: theme.colors.ctaText,
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
