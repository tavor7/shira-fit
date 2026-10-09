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

/** Dark or white initials, whichever contrasts more with the circle colour (fixed dark text was 4.2:1 on blue). */
function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return theme.colors.ctaText;
  const lin = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (1.05) / (L + 0.05) > (L + 0.05) / 0.05 ? "#ffffff" : theme.colors.ctaText;
}

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
      <Text style={[styles.txt, { fontSize: size * 0.38, color: readableOn(bg) }]}>{initials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  txt: { fontWeight: "900", color: theme.colors.ctaText },
});
