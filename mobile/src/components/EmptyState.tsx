import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { AppText } from "./AppText";
import { AppIcon, type AppIconName } from "./AppIcon";
import { PrimaryButton } from "./PrimaryButton";
import { FadeSlideIn } from "./FadeSlideIn";

/**
 * Screen/list states after loading has finished:
 * - `empty` (default): the request succeeded and there is nothing to show.
 * - `error`: the request failed; pair with a retry action.
 * - `notFound`: the requested item does not exist or is not accessible.
 * Loading is a separate state (skeletons for lists, LoadingState for one-off transitions).
 */
export type StateTone = "empty" | "error" | "notFound";

type Props = {
  title: string;
  body?: string;
  /** Ionicons name; each tone has a default. */
  icon?: AppIconName;
  tone?: StateTone;
  actionLabel?: string;
  onAction?: () => void;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
};

const DEFAULT_ICON: Record<StateTone, AppIconName> = {
  empty: "file-tray-outline",
  error: "cloud-offline-outline",
  notFound: "help-circle-outline",
};

export function EmptyState({ title, body, icon, tone = "empty", actionLabel, onAction, isRTL, style }: Props) {
  const isError = tone === "error";
  return (
    <FadeSlideIn
      style={[styles.wrap, style]}
      accessibilityRole={isError ? "alert" : "text"}
      accessibilityLiveRegion={isError ? "polite" : undefined}
    >
      <View style={[styles.iconWrap, isError && styles.iconWrapError]}>
        <AppIcon name={icon ?? DEFAULT_ICON[tone]} size="lg" color={isError ? theme.colors.error : theme.colors.textMuted} />
      </View>
      <AppText variant="title" isRTL={isRTL} style={styles.title}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="secondary" muted isRTL={isRTL} style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {actionLabel && onAction ? (
        <PrimaryButton label={actionLabel} onPress={onAction} variant="ghost" style={styles.action} />
      ) : null}
    </FadeSlideIn>
  );
}

/** Failed request: localized message (see lib/userFacingError) and, where possible, a retry. */
export function ErrorState(props: Omit<Props, "tone">) {
  return <EmptyState {...props} tone="error" />;
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.xs,
  },
  iconWrapError: {
    backgroundColor: theme.colors.errorBg,
    borderColor: theme.colors.errorBorder,
  },
  title: {
    textAlign: "center",
  },
  body: {
    textAlign: "center",
    maxWidth: 360,
  },
  action: {
    marginTop: theme.spacing.sm,
    alignSelf: "center",
    minWidth: 160,
    maxWidth: 280,
  },
});
