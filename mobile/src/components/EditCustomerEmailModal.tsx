import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { useI18n } from "../context/I18nContext";
import { updateDocumentCustomerEmail } from "../lib/documents";

type Props = {
  visible: boolean;
  documentId: string | null;
  customerName: string;
  initialEmail: string | null;
  onClose: () => void;
  onSaved: (email: string | null) => void | Promise<void>;
};

export function EditCustomerEmailModal({
  visible,
  documentId,
  customerName,
  initialEmail,
  onClose,
  onSaved,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setEmail(initialEmail ?? "");
    setError("");
    setBusy(false);
  }, [visible, initialEmail]);

  async function save() {
    if (!documentId) return;
    setError("");
    setBusy(true);
    try {
      const saved = await updateDocumentCustomerEmail(documentId, email.trim());
      await onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="dialog"
      backdropAccessibilityLabel={t("common.close")}
    >
      <View style={styles.body}>
        <Text style={[styles.title, isRTL && styles.rtl]}>
          {language === "he" ? "אימייל לקוח" : "Customer email"}
        </Text>
        <Text style={[styles.sub, isRTL && styles.rtl]} numberOfLines={2}>
          {customerName}
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={language === "he" ? "name@example.com" : "name@example.com"}
          placeholderTextColor={theme.colors.textSoft}
          style={[styles.input, isRTL && styles.rtlInput]}
        />
        {error ? <Text style={[styles.error, isRTL && styles.rtl]}>{error}</Text> : null}
        <PrimaryButton
          label={language === "he" ? "שמירה" : "Save"}
          onPress={() => void save()}
          loading={busy}
          loadingLabel={t("common.loading")}
        />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  body: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  sub: { fontSize: 14, fontWeight: "600", color: theme.colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceElevated,
    fontSize: 15,
    fontWeight: "600",
  },
  rtlInput: { textAlign: "right", writingDirection: "rtl" },
  error: { fontSize: 13, fontWeight: "700", color: theme.colors.error },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
