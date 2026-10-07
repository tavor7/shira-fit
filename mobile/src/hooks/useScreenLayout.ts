import { useMemo } from "react";
import { useWindowDimensions, type ViewStyle } from "react-native";
import { useBottomChrome } from "../context/BottomChromeContext";
import { screenContentFrame, scrollContentBottomPadding, type ContentWidth } from "../lib/screenLayout";

/**
 * Style for a screen's main content container (append it to a ScrollView/FlatList
 * `contentContainerStyle`, or to the root View of a non-scrolling screen): the gutter for this
 * viewport, a centred maximum width for the content type, and bottom clearance for the
 * bottom chrome (floating accessibility button, safe area). See lib/screenLayout.ts.
 */
export function useScreenContentStyle(width: ContentWidth, opts?: { scrolls?: boolean }): ViewStyle {
  const { width: viewportWidth } = useWindowDimensions();
  const chrome = useBottomChrome();
  const scrolls = opts?.scrolls !== false;
  return useMemo(() => {
    const frame = screenContentFrame(viewportWidth, width);
    return {
      width: "100%",
      maxWidth: frame.maxWidth,
      alignSelf: "center",
      paddingHorizontal: frame.paddingHorizontal,
      ...(scrolls ? { paddingBottom: scrollContentBottomPadding(chrome) } : null),
    };
  }, [viewportWidth, width, chrome, scrolls]);
}
