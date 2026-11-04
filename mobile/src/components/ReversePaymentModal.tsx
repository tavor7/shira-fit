import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { rowFlipFor } from "../lib/layoutDirection";

type Props = {
  visible: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
};

/** A payment recorded against a subscription is reversed, with a reason, and stays in the history. */
export function ReversePaymentModal({ visible, busy, onCancel, onConfirm }: Props) {
  const { t, isRTL } = useI18n();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (visible) setReason("");
  }, [visible]);
  const valid = reason.trim().length >= 3;

  return (
    <AppModal visible={visible} onClose={onCancel} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("common.cancel")}>
      <View style={styles.card}>
        <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
          {t("billing.reversePaymentTitle")}
        </Text>
        <Text style={[styles.message, isRTL && styles.rtl]}>{t("billing.reversePaymentMessage")}</Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t("billing.reversePaymentReason")}
          placeholderTextColor={theme.colors.textSoft}
          accessibilityLabel={t("billing.reversePaymentReason")}
          style={[styles.input, isRTL && styles.rtl]}
        />
        <View style={[styles.actions, rowFlipFor(isRTL) && styles.actionsRtl]}>
          <PrimaryButton label={t("common.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          <PrimaryButton label={t("billing.reversePaymentConfirm")} onPress={() => onConfirm(reason.trim())} disabled={!valid} loading={busy} variant="danger" style={styles.btn} />
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.spacing.md, gap: theme.spacing.sm },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  message: { fontSize: 14, lineHeight: 20, color: theme.colors.textMuted },
  input: { minHeight: 44, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderInput, backgroundColor: theme.colors.surfaceElevated, color: theme.colors.text, fontSize: 16 },
  actions: { flexDirection: "row", gap: theme.spacing.sm },
  actionsRtl: { flexDirection: "row-reverse" },
  btn: { flex: 1 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
