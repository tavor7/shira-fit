import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import type { StyleProp, TextStyle } from "react-native";
import { theme } from "../theme";

export type AppIconName = ComponentProps<typeof Ionicons>["name"];

/** Icon sizes: inline with caption/label text, inline with body text, standalone controls, empty/error states. */
export const ICON_SIZE = { sm: 16, md: 20, lg: 24, state: 40 } as const;

type Props = {
  name: AppIconName;
  size?: keyof typeof ICON_SIZE | number;
  color?: string;
  style?: StyleProp<TextStyle>;
  /** Decorative by default; pass a label only when the icon carries meaning on its own. */
  accessibilityLabel?: string;
};

/** The app's single icon family (Ionicons, outline style by convention). */
export function AppIcon({ name, size = "md", color = theme.colors.text, style, accessibilityLabel }: Props) {
  const px = typeof size === "number" ? size : ICON_SIZE[size];
  return (
    <Ionicons
      name={name}
      size={px}
      color={color}
      style={style}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? "yes" : "no-hide-descendants"}
    />
  );
}
