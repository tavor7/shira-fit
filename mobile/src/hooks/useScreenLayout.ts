import { useMemo } from "react";
import { useWindowDimensions, type ViewStyle } from "react-native";
import { useBottomChrome } from "../context/BottomChromeContext";
import { screenContentFrame, scrollContentBottomPadding, type ContentWidth } from "../lib/screenLayout";

/**
 * Style for a screen's main content container (append it to a ScrollView/FlatList
 * `contentContainerStyle`, or to the root View of a non-scrolling screen): the gutter for this
 * viewport, a centred maximum width for the content type, and bottom clearance for the
 * bottom chrome (floating accessibility button, safe area). See lib/screenLayout.ts.
 *
 * `selfInset`: horizontal padding the screen's sections already apply themselves (calendar screens
 * pad each section and let the week strip run edge to edge); it is subtracted from the gutter so
 * their content lines up with every other screen.
 */
export function useScreenContentStyle(width: ContentWidth, opts?: { scrolls?: boolean; selfInset?: number }): ViewStyle {
  const { width: viewportWidth } = useWindowDimensions();
  const chrome = useBottomChrome();
  const scrolls = opts?.scrolls !== false;
  const selfInset = opts?.selfInset ?? 0;
  return useMemo(() => {
    const frame = screenContentFrame(viewportWidth, width);
    return {
      width: "100%",
      maxWidth: frame.maxWidth,
      alignSelf: "center",
      paddingHorizontal: Math.max(0, frame.paddingHorizontal - selfInset),
      ...(scrolls ? { paddingBottom: scrollContentBottomPadding(chrome) } : null),
    };
  }, [viewportWidth, width, chrome, scrolls, selfInset]);
}
