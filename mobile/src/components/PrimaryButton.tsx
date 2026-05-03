import { Pressable, Text, View, ActivityIndicator, StyleSheet, ViewStyle, TextStyle, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { theme } from "../theme";

function primaryTapFeedback() {
  if (Platform.OS === "ios" || Platform.OS === "android") {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

type Props = {
  label: string;
  loadingLabel?: string;
  loading?: boolean;
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
  /** `cta` = light filled (main). `ghost` = dark filled subtle border. */
  variant?: "cta" | "ghost";
};

export function PrimaryButton({
  label,
  loadingLabel = "Loading…",
  loading,
  onPress,
  disabled,
  style,
  variant = "cta",
}: Props) {
  const busy = loading || disabled;
  const isCta = variant === "cta";
  return (
    <Pressable
      style={({ pressed }) => [
        styles.btn,
        isCta ? styles.btnCta : styles.btnGhost,
        busy && styles.disabled,
        pressed && !busy && (isCta ? styles.pressedCta : styles.pressedGhost),
        style,
      ]}
      onPress={() => {
        if (busy) return;
        primaryTapFeedback();
        onPress();
      }}
      disabled={busy}
      android_ripple={{
        color: isCta ? "rgba(10,10,11,0.12)" : "rgba(244,244,245,0.08)",
      }}
    >
      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator color={isCta ? theme.colors.ctaText : theme.colors.text} style={{ marginRight: 10 }} />
          <Text style={[styles.text, isCta ? styles.textCta : styles.textGhost]}>{loadingLabel}</Text>
        </View>
      ) : (
        <Text style={[styles.text, isCta ? styles.textCta : styles.textGhost]} maxFontSizeMultiplier={theme.a11y.bodyMaxFontMultiplier}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: theme.radius.md,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  btnCta: {
    backgroundColor: theme.colors.cta,
  },
  btnGhost: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  disabled: { opacity: 0.5 },
  pressedCta: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  pressedGhost: { opacity: 0.88 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  text: { fontWeight: "600", fontSize: 16, letterSpacing: 0.2 } as TextStyle,
  textCta: { color: theme.colors.ctaText },
  textGhost: { color: theme.colors.text },
});
