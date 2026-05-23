import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** Bottom inset (px) when the software keyboard is open — 0 on web and when hidden. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setInset(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setInset(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return inset;
}
