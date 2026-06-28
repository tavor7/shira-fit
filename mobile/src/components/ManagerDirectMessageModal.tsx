import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  Modal,
  StyleSheet,
  View,
} from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { fetchRequiredConsents } from "../lib/consent";
import {
  fetchPendingManagerDirectMessage,
  markManagerDirectMessageRead,
  initialsFromName,
  type PendingManagerMessage,
} from "../lib/managerDirectMessages";
import { AppText } from "./AppText";
import { PrimaryButton } from "./PrimaryButton";

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
  const initials = initialsFromName(senderLabel);

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.backdrop} accessibilityViewIsModal>
        <View style={styles.card}>
          <View style={styles.headerGlow} />
          <View style={styles.headerGlowSecondary} />
          <View style={styles.header}>
            <View style={styles.avatarRing}>
              <View style={styles.avatar}>
                <AppText variant="title" style={styles.avatarTxt}>
                  {initials}
                </AppText>
              </View>
            </View>
            <AppText variant="caption" muted isRTL={isRTL} style={styles.kicker}>
              {t("managerMessage.inboxKicker")}
            </AppText>
            <AppText variant="headline" isRTL={isRTL} style={styles.senderName}>
              {senderLabel}
            </AppText>
          </View>

          <View style={styles.bubbleWrap}>
            <View style={[styles.bubble, isRTL && styles.bubbleRtl]}>
              <AppText variant="body" isRTL={isRTL} style={styles.bubbleText}>
                {message.body}
              </AppText>
            </View>
          </View>

          <PrimaryButton
            label={dismissing ? t("common.loading") : t("managerMessage.gotIt")}
            onPress={() => void dismiss()}
            disabled={dismissing}
            loading={dismissing}
            loadingLabel={t("common.loading")}
            style={styles.cta}
          />
        </View>
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
  },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    paddingBottom: theme.spacing.lg,
  },
  headerGlow: {
    position: "absolute",
    top: -40,
    left: -20,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(99, 102, 241, 0.35)",
  },
  headerGlowSecondary: {
    position: "absolute",
    top: -10,
    right: -30,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(217, 70, 239, 0.22)",
  },
  header: {
    alignItems: "center",
    paddingTop: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: 4,
  },
  avatarRing: {
    padding: 3,
    borderRadius: theme.radius.full,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginBottom: theme.spacing.sm,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7c6cf0",
  },
  avatarTxt: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  kicker: {
    textTransform: "uppercase",
    letterSpacing: 1.2,
    fontWeight: "800",
    fontSize: 11,
    color: theme.colors.textSoft,
  },
  senderName: {
    textAlign: "center",
    color: theme.colors.text,
  },
  bubbleWrap: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
  },
  bubble: {
    backgroundColor: theme.colors.backgroundAlt,
    borderRadius: theme.radius.lg,
    borderTopLeftRadius: 6,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  bubbleRtl: {
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: 6,
  },
  bubbleText: {
    lineHeight: 22,
    color: theme.colors.text,
  },
  cta: {
    marginHorizontal: theme.spacing.lg,
  },
});
