import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "./AppText";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

/**
 * A refresh failed but earlier data is still on screen (Performance Phase 1 / step 5): say so, so the shown counts and
 * places are not taken as current, and offer a retry. Registration itself is always decided by the server.
 */
export function RefreshFailedNotice({ onRetry }: { onRetry: () => void }) {
  const { t, isRTL } = useI18n();
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <AppText variant="caption" isRTL={isRTL} style={styles.txt}>
        {t("common.refreshFailedKeptData")}
      </AppText>
      <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
        <AppText variant="caption" isRTL={isRTL} style={styles.retry}>
          {t("auth.retryConnection")}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  txt: { color: theme.colors.error },
  retry: { color: theme.colors.error, fontWeight: "700", textDecorationLine: "underline" },
});
