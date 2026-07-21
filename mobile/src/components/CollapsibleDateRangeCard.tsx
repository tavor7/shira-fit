import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { formatISODateFull } from "../lib/dateFormat";
import { ReportDateRangeControls } from "./ReportDateRangeControls";

type Props = {
  start: string;
  end: string;
  onChange: (range: { start: string; end: string }) => void;
  label: string;
};

/** Collapsed by default — shows just the current range as one line; tap to expand the full picker. */
export function CollapsibleDateRangeCard({ start, end, onChange, label }: Props) {
  const { language, isRTL } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
      >
        <View style={styles.toggleCopy}>
          <Text style={[styles.label, isRTL && styles.rtl]}>{label}</Text>
          <Text style={[styles.summary, isRTL && styles.rtl]} numberOfLines={1}>
            {formatISODateFull(start, language)} – {formatISODateFull(end, language)}
          </Text>
        </View>
        <Text style={styles.chevron}>{open ? "︿" : "﹀"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          <ReportDateRangeControls start={start} end={end} onChange={onChange} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  togglePressed: { opacity: 0.9 },
  toggleCopy: { flex: 1 },
  label: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.35,
  },
  summary: { fontSize: 13, fontWeight: "700", color: theme.colors.text, marginTop: 2 },
  chevron: { fontSize: 14, fontWeight: "800", color: theme.colors.textSoft },
  body: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    paddingTop: theme.spacing.sm,
  },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
