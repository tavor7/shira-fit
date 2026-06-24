import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { PrimaryButton } from "./PrimaryButton";

type Props = {
  title: string;
  body?: string;
  /** Optional emoji or short symbol shown above the title. */
  icon?: string;
  actionLabel?: string;
  onAction?: () => void;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function EmptyState({ title, body, icon, actionLabel, onAction, isRTL, style }: Props) {
  return (
    <View style={[styles.wrap, style]} accessibilityRole="text">
      {icon ? (
        <AppText variant="display" style={styles.icon} accessibilityElementsHidden>
          {icon}
        </AppText>
      ) : null}
      <AppText variant="title" isRTL={isRTL} style={styles.title}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="body" muted isRTL={isRTL} style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {actionLabel && onAction ? (
        <PrimaryButton label={actionLabel} onPress={onAction} variant="ghost" style={styles.action} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  icon: {
    fontSize: 32,
    lineHeight: 40,
    marginBottom: theme.spacing.xs,
    textAlign: "center",
  },
  title: {
    textAlign: "center",
  },
  body: {
    textAlign: "center",
    maxWidth: 320,
  },
  action: {
    marginTop: theme.spacing.sm,
    alignSelf: "stretch",
    maxWidth: 280,
  },
});
