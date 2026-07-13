import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import {
  ACCOUNT_PAYMENT_SERVICE_TYPE_KEYS,
  type DocumentServiceTypeKey,
  documentServiceTypeLabel,
} from "../lib/documentServiceTypes";

type Props = {
  label: string;
  value: DocumentServiceTypeKey;
  onChange: (next: DocumentServiceTypeKey) => void;
  language: "he" | "en";
  isRTL?: boolean;
};

export function ServiceTypePickerField({ label, value, onChange, language, isRTL }: Props) {
  const [open, setOpen] = useState(false);
  const lang = language === "he" ? "he" : "en";
  const selectedLabel = documentServiceTypeLabel(value, lang);

  function pick(next: DocumentServiceTypeKey) {
    onChange(next);
    setOpen(false);
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.fieldLabel, isRTL && styles.rtl]}>{label}</Text>
      <Pressable
        style={({ pressed }) => [styles.field, isRTL && styles.fieldRtl, pressed && { opacity: 0.92 }]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text style={[styles.fieldText, isRTL && styles.rtl]} numberOfLines={1}>
          {selectedLabel}
        </Text>
        <Text style={styles.chevron}>▼</Text>
      </Pressable>

      <AppModal
        visible={open}
        onClose={() => setOpen(false)}
        variant="sheet"
        maxHeightPct={0.62}
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Close"}
      >
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={[styles.sheetTitle, isRTL && styles.rtl]}>
            {language === "he" ? "בחירת סוג שירות" : "Choose service type"}
          </Text>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {ACCOUNT_PAYMENT_SERVICE_TYPE_KEYS.map((k, idx) => {
              const selected = k === value;
              return (
                <View key={k}>
                  {idx > 0 ? <View style={styles.divider} /> : null}
                  <Pressable
                    style={({ pressed }) => [
                      styles.option,
                      isRTL && styles.optionRtl,
                      selected && styles.optionSelected,
                      pressed && !selected && { opacity: 0.88 },
                    ]}
                    onPress={() => pick(k)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.optionText, selected && styles.optionTextSelected, isRTL && styles.rtl]}>
                      {documentServiceTypeLabel(k, lang)}
                    </Text>
                    {selected ? <Text style={styles.check}>✓</Text> : <View style={styles.checkSpacer} />}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  field: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  fieldRtl: { flexDirection: "row-reverse" },
  fieldText: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.text },
  chevron: { fontSize: 10, color: theme.colors.textMuted, marginTop: 1 },
  sheet: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.borderMuted,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  list: {
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    maxHeight: 360,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.borderMuted, marginHorizontal: theme.spacing.md },
  option: {
    minHeight: 50,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  optionRtl: { flexDirection: "row-reverse" },
  optionSelected: { backgroundColor: theme.colors.surfaceElevated },
  optionText: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.text },
  optionTextSelected: { fontWeight: "800", color: theme.colors.text },
  check: { fontSize: 16, fontWeight: "900", color: theme.colors.cta, width: 20, textAlign: "center" },
  checkSpacer: { width: 20 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
