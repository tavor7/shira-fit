import { StyleSheet, Text } from "react-native";
import { theme } from "../theme";

/**
 * Page title in the app header. React Navigation passes the screen's `title` option as children,
 * or the raw route name when a screen sets none (e.g. "manager/session/[id]") — those are never shown.
 */
export function AppHeaderTitle({ children }: { children?: string }) {
  const title = typeof children === "string" ? children.trim() : "";
  if (!title || /[/[\]()]/.test(title) || title === "index") return null;
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      style={styles.title}
      maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}
    >
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  title: { ...theme.typography.headline, color: theme.colors.text },
});
