import type { ReactNode } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";

type Props = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  saveLabel: string;
  onSave: () => void;
  saving?: boolean;
  loadingLabel?: string;
  cancelLabel: string;
  isRTL?: boolean;
};

export function PricingFormModal({
  visible,
  title,
  onClose,
  children,
  saveLabel,
  onSave,
  saving,
  loadingLabel,
  cancelLabel,
  isRTL,
}: Props) {
  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="dialog"
      maxHeightPct={0.85}
      backdropAccessibilityLabel={cancelLabel}
    >
      <View style={[styles.header, isRTL && styles.headerRtl]}>
        <Text style={[styles.title, isRTL && styles.rtl]} numberOfLines={2}>
          {title}
        </Text>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
        >
          <Text style={styles.closeTxt}>✕</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      <View style={styles.footer}>
        <PrimaryButton
          label={saveLabel}
          onPress={onSave}
          loading={saving}
          loadingLabel={loadingLabel}
        />
        <Pressable onPress={onClose} style={styles.cancel}>
          <Text style={[styles.cancelTxt, isRTL && styles.rtl]}>{cancelLabel}</Text>
        </Pressable>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: { flex: 1, fontSize: 18, fontWeight: "800", color: theme.colors.text },
  close: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  closeTxt: { fontSize: 16, fontWeight: "700", color: theme.colors.textMuted },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: theme.spacing.md, gap: 12, paddingBottom: theme.spacing.sm },
  footer: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
  },
  cancel: { alignItems: "center", paddingVertical: 6 },
  cancelTxt: { fontSize: 14, fontWeight: "700", color: theme.colors.textMuted },
  rtl: { textAlign: "right" },
});
