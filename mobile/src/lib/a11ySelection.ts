import type { AccessibilityRole, AccessibilityState } from "react-native";

/**
 * Selection semantics for custom selection controls.
 *
 * react-native-web does not turn `accessibilityState.selected` / `.checked` into ARIA attributes, so on
 * the web a selected segment or chip was announced as an ordinary button. These props set the role and
 * the matching ARIA state explicitly (native keeps using accessibilityState):
 * - `tab`: one of a set of tabs (`aria-selected`); put the tabs in a `tablist`.
 * - `radio`: single choice among options — segments, presets, pickers (`aria-checked`); group them
 *   in a `radiogroup`.
 * - `checkbox`: independent on/off choice, or one item of a multi-select (`aria-checked`).
 * - `toggle`: a button that stays pressed (`aria-pressed`).
 */
export type SelectionKind = "tab" | "radio" | "checkbox" | "toggle";

export type SelectionA11yProps = {
  accessibilityRole: AccessibilityRole;
  accessibilityState: AccessibilityState;
  "aria-selected"?: boolean;
  "aria-checked"?: boolean;
  "aria-pressed"?: boolean;
};

export function selectionA11y(kind: SelectionKind, selected: boolean, disabled?: boolean): SelectionA11yProps {
  const base = disabled ? { disabled: true } : {};
  switch (kind) {
    case "tab":
      return { accessibilityRole: "tab", accessibilityState: { ...base, selected }, "aria-selected": selected };
    case "radio":
      return { accessibilityRole: "radio", accessibilityState: { ...base, checked: selected }, "aria-checked": selected };
    case "checkbox":
      return { accessibilityRole: "checkbox", accessibilityState: { ...base, checked: selected }, "aria-checked": selected };
    case "toggle":
      return { accessibilityRole: "button", accessibilityState: { ...base, selected }, "aria-pressed": selected };
  }
}
