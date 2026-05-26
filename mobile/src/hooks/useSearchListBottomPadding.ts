import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardInset } from "./useKeyboardInset";

/** Extra bottom space so list content stays above the keyboard (native). */
export function useSearchListBottomPadding(extra = 24): number {
  const keyboardInset = useKeyboardInset();
  const insets = useSafeAreaInsets();
  return keyboardInset + Math.max(insets.bottom, extra);
}
