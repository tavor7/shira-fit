import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

type Props = {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  /** Optional style applied to the resolved-content wrapper (e.g. `{ flex: 1 }` when children need to fill the screen). */
  style?: StyleProp<ViewStyle>;
};

/** Cross-dissolves a loading skeleton into its resolved content instead of a hard cut. */
export function CrossfadeSwap({ loading, skeleton, children, style }: Props) {
  const skeletonOpacity = useRef(new Animated.Value(loading ? 1 : 0)).current;
  const contentOpacity = useRef(new Animated.Value(loading ? 0 : 1)).current;
  const [showSkeleton, setShowSkeleton] = useState(loading);
  const reduceMotionRef = useReduceMotionRef();

  useEffect(() => {
    if (reduceMotionRef.current) {
      skeletonOpacity.setValue(loading ? 1 : 0);
      contentOpacity.setValue(loading ? 0 : 1);
      setShowSkeleton(loading);
      return;
    }
    if (loading) {
      setShowSkeleton(true);
      Animated.timing(contentOpacity, {
        toValue: 0,
        duration: theme.motion.fast,
        easing: theme.motion.easeIn,
        useNativeDriver: true,
      }).start();
      Animated.timing(skeletonOpacity, {
        toValue: 1,
        duration: theme.motion.fast,
        easing: theme.motion.easeOut,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(skeletonOpacity, {
        toValue: 0,
        duration: theme.motion.fast,
        easing: theme.motion.easeIn,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setShowSkeleton(false);
      });
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: theme.motion.fast,
        easing: theme.motion.easeOut,
        useNativeDriver: true,
      }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <>
      {!loading ? <Animated.View style={[style, { opacity: contentOpacity }]}>{children}</Animated.View> : null}
      {showSkeleton ? (
        <Animated.View style={[!loading && StyleSheet.absoluteFill, { opacity: skeletonOpacity }]}>
          {skeleton}
        </Animated.View>
      ) : null}
    </>
  );
}
