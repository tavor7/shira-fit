import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import { TRAINER_COLOR_PRESETS } from "../lib/trainerCalendarColor";

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

type Props = {
  name: string;
  seed: string;
  size?: number;
  /** Overrides the deterministic hash color (e.g. a stored calendar_color). */
  color?: string | null;
};

/** Small colored initials circle — consistent identity marker for user rows app-wide. */
export function UserAvatar({ name, seed, size = 40, color }: Props) {
  const bg = color?.trim() || TRAINER_COLOR_PRESETS[hashSeed(seed) % TRAINER_COLOR_PRESETS.length];
  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
      ]}
    >
      <Text style={[styles.txt, { fontSize: size * 0.38 }]}>{initials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  txt: { fontWeight: "900", color: theme.colors.ctaText },
});
