import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";

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
  /** Used to force remount on web so the dialog stays frontmost. */
  instanceKey?: number;
};

/**
 * Generic on-brand alert / confirm (mobile + web). Built on {@link AppModal} (`variant="dialog"`)
 * so backdrop/shadow/sizing stay in sync with every other sheet/popover in the app.
 */
export function AppAlertDialog({ visible, title, message, actions, onRequestClose, isRTL, instanceKey }: Props) {
  return (
    <AppModal
      key={instanceKey}
      visible={visible}
      onClose={onRequestClose}
      variant="dialog"
      backdropAccessibilityLabel={actions[0]?.label ?? ""}
    >
      <View style={styles.card}>
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
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: theme.spacing.lg,
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
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
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
