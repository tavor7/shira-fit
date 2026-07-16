import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

const COLORS = [
  theme.colors.cta,
  theme.colors.success,
  theme.colors.info,
  theme.colors.warning,
  theme.colors.calendarNoteInfo,
  theme.colors.calendarNoteHoliday,
];

const PARTICLE_COUNT = 16;

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

type ParticleConfig = {
  color: string;
  size: number;
  isCircle: boolean;
  dx: number;
  peakY: number;
  fallY: number;
  rotation: number;
  duration: number;
  delay: number;
};

function makeParticle(): ParticleConfig {
  return {
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    size: randomBetween(5, 9),
    isCircle: Math.random() > 0.5,
    dx: randomBetween(-70, 70),
    peakY: randomBetween(-70, -30),
    fallY: randomBetween(15, 55),
    rotation: randomBetween(-200, 200),
    duration: randomBetween(550, 800),
    delay: randomBetween(0, 80),
  };
}

type Props = {
  /** Fires a new burst each time this flips from false to true. */
  trigger: boolean;
};

/** Small particle burst radiating from the center of the wrapping view — fires once per rising edge of `trigger`. */
export function ConfettiBurst({ trigger }: Props) {
  const reduceMotionRef = useReduceMotionRef();
  const particlesRef = useRef<ParticleConfig[]>([]);
  const progressesRef = useRef<Animated.Value[]>(
    Array.from({ length: PARTICLE_COUNT }, () => new Animated.Value(0))
  );
  const wasTriggeredRef = useRef(false);
  const [hasBurst, setHasBurst] = useState(false);

  useEffect(() => {
    if (trigger && !wasTriggeredRef.current) {
      wasTriggeredRef.current = true;
      if (!reduceMotionRef.current) {
        particlesRef.current = Array.from({ length: PARTICLE_COUNT }, makeParticle);
        setHasBurst(true);
        const anims = progressesRef.current.map((v, i) => {
          v.setValue(0);
          const cfg = particlesRef.current[i];
          return Animated.timing(v, {
            toValue: 1,
            duration: cfg.duration,
            delay: cfg.delay,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          });
        });
        Animated.parallel(anims).start(({ finished }) => {
          if (finished) setHasBurst(false);
        });
      }
    } else if (!trigger) {
      wasTriggeredRef.current = false;
    }
  }, [trigger, reduceMotionRef]);

  if (!hasBurst) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {progressesRef.current.map((progress, i) => {
        const cfg = particlesRef.current[i];
        if (!cfg) return null;
        const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, cfg.dx] });
        const translateY = progress.interpolate({
          inputRange: [0, 0.45, 1],
          outputRange: [0, cfg.peakY, cfg.peakY + cfg.fallY],
        });
        const opacity = progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 1, 0] });
        const rotate = progress.interpolate({
          inputRange: [0, 1],
          outputRange: ["0deg", `${cfg.rotation}deg`],
        });
        return (
          <Animated.View
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: cfg.size,
              height: cfg.size,
              marginLeft: -cfg.size / 2,
              marginTop: -cfg.size / 2,
              borderRadius: cfg.isCircle ? cfg.size / 2 : 2,
              backgroundColor: cfg.color,
              opacity,
              transform: [{ translateX }, { translateY }, { rotate }],
            }}
          />
        );
      })}
    </View>
  );
}
