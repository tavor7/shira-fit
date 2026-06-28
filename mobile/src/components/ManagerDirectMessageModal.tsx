import { useCallback, useEffect, useState } from "react";
import { AppState, Modal, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { fetchRequiredConsents } from "../lib/consent";
import {
  fetchPendingManagerDirectMessage,
  markManagerDirectMessageRead,
  type PendingManagerMessage,
} from "../lib/managerDirectMessages";
import { AppText } from "./AppText";
import { PrimaryButton } from "./PrimaryButton";
import { ManagerMessageCard } from "./ManagerMessageCard";

/** Shows the oldest unread manager message after app load; chains if multiple are pending. */
export function ManagerDirectMessageModal() {
  const { session, profile } = useAuth();
  const { t, isRTL } = useI18n();
  const [blockedByConsent, setBlockedByConsent] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<PendingManagerMessage | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(async () => {
    if (!session?.user?.id) {
      setMessage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const required = await fetchRequiredConsents();
      const needsConsent = required.some((c) => c.consent_type === "electronic_receipts");
      setBlockedByConsent(needsConsent);
      if (needsConsent) {
        setMessage(null);
        return;
      }
      setMessage(await fetchPendingManagerDirectMessage());
    } catch {
      setMessage(null);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id, profile?.electronic_receipts_consent_version]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => sub.remove();
  }, [load]);

  async function dismiss() {
    if (!message || dismissing) return;
    setDismissing(true);
    const ok = await markManagerDirectMessageRead(message.id);
    setDismissing(false);
    if (!ok) return;
    setMessage(null);
    const next = await fetchPendingManagerDirectMessage();
    setMessage(next);
  }

  if (!session || loading || blockedByConsent || !message) return null;

  const senderLabel = message.sender_name.trim() || t("managerMessage.studioFallback");

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.backdrop} accessibilityViewIsModal>
        <ManagerMessageCard
          messageTheme={message.message_theme}
          senderName={senderLabel}
          body={message.body}
          inboxKicker={t("managerMessage.inboxKicker")}
          isRTL={isRTL}
        />
        <PrimaryButton
          label={dismissing ? t("common.loading") : t("managerMessage.gotIt")}
          onPress={() => void dismiss()}
          disabled={dismissing}
          loading={dismissing}
          loadingLabel={t("common.loading")}
          style={styles.cta}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 8, 12, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.lg,
    zIndex: 9998,
    gap: theme.spacing.md,
  },
  cta: {
    width: "100%",
    maxWidth: 400,
  },
});
