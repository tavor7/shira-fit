import type { TextStyle, ViewStyle } from "react-native";
import { theme } from "../theme";

export const appHeaderStyle: ViewStyle = {
  backgroundColor: theme.colors.backgroundAlt,
  borderBottomWidth: 1,
  borderBottomColor: theme.colors.borderMuted,
};

export const appHeaderTitleStyle: TextStyle = {
  fontWeight: theme.typography.title.fontWeight,
  fontSize: 17,
  color: theme.colors.text,
  letterSpacing: 0.2,
};
