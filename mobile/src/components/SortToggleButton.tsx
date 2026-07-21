import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

type SortOrder = "asc" | "desc";

type Props = {
  value: SortOrder;
  onChange: (value: SortOrder) => void;
  ascLabel: string;
  descLabel: string;
};

/** Single compact pill that flips asc/desc on tap, instead of two side-by-side chips. */
export function SortToggleButton({ value, onChange, ascLabel, descLabel }: Props) {
  const { isRTL } = useI18n();
  return (
    <Pressable
      onPress={() => onChange(value === "asc" ? "desc" : "asc")}
      style={({ pressed }) => [styles.btn, isRTL && styles.btnRtl, pressed && styles.btnPressed]}
    >
      <Text style={styles.arrow}>{value === "asc" ? "↑" : "↓"}</Text>
      <Text style={[styles.label, isRTL && styles.rtl]} numberOfLines={1}>
        {value === "asc" ? ascLabel : descLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  btnRtl: { flexDirection: "row-reverse" },
  btnPressed: { opacity: 0.88 },
  arrow: { fontSize: 13, fontWeight: "900", color: theme.colors.text },
  label: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
