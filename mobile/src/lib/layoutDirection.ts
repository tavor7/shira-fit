import { I18nManager, Platform } from "react-native";

/**
 * Directionality model (Phase 4A).
 *
 * The UI direction comes from the language (Hebrew → RTL). Layout should mirror exactly once:
 * - Web: I18nContext sets `<html dir>` from the language, and the browser already mirrors every
 *   flex row (`flex-direction: row` follows `direction`). react-native-web's I18nManager is a no-op.
 * - Native: rows follow `I18nManager.isRTL`, which only changes after `forceRTL` + an app restart,
 *   so it can temporarily disagree with the selected language.
 *
 * Components must therefore reverse a row manually only when the platform is NOT already laying it
 * out in the UI direction. Using `isRTL` for that decision double-mirrors on web (rows back to LTR).
 */
export function platformLayoutIsRTL(platformOS: string, uiIsRTL: boolean, nativeI18nIsRTL: boolean): boolean {
  return platformOS === "web" ? uiIsRTL : nativeI18nIsRTL;
}

/** True when a component must apply `flexDirection: "row-reverse"` itself to match the UI direction. */
export function shouldFlipRows(platformOS: string, uiIsRTL: boolean, nativeI18nIsRTL: boolean): boolean {
  return uiIsRTL !== platformLayoutIsRTL(platformOS, uiIsRTL, nativeI18nIsRTL);
}

/**
 * `shouldFlipRows` for the current platform. For components that receive the UI direction as a prop
 * (`isRTL`); components that call `useI18n()` can use its `rowFlip`, which is the same value.
 */
export function rowFlipFor(uiIsRTL: boolean | undefined): boolean {
  return shouldFlipRows(Platform.OS, uiIsRTL === true, I18nManager.isRTL === true);
}

/**
 * Props for a <Text> that shows user-provided content on its own (a name, a free-text note).
 * Text normally follows the UI direction (see app/_layout.tsx), but a single truncated line of
 * Latin content inside a Hebrew screen would then lose its beginning to the ellipsis; marked text
 * keeps react-native-web's content-based `dir="auto"`. Web only (native has no global override).
 */
export const userContentTextProps: object = Platform.OS === "web" ? { dataSet: { bidi: "content" } } : {};
