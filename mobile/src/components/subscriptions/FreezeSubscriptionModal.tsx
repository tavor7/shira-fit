import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { DateRangeFormPanel } from "../DateRangeFormPanel";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import { rpcFreezeSubscription, type SubscriptionImpact } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  subscriptionId: string;
  onClose: () => void;
  onSaved: () => void;
};

export function FreezeSubscriptionModal({ visible, subscriptionId, onClose, onSaved }: Props) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();

  const today = toISODateLocal(new Date());
  const [freezeFrom, setFreezeFrom] = useState(today);
  const [freezeUntil, setFreezeUntil] = useState(today);
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);

  function reset() {
    setFreezeFrom(today);
    setFreezeUntil(today);
    setSubmitting(false);
    setImpact(null);
    setImpactOpen(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function runFreeze(confirmed: boolean) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await rpcFreezeSubscription(supabase, subscriptionId, freezeFrom, freezeUntil, confirmed);
      if (!res.ok) {
        const msg = res.error === "freeze_overlap" ? t("subscriptions.freeze.overlap") : t("subscriptions.genericError");
        showToast({ message: msg, variant: "error" });
        return;
      }
      if (res.action === "preview") {
        setImpact(res.impact ?? null);
        setImpactOpen(true);
        return;
      }
      showToast({ message: t("subscriptions.freeze.success"), variant: "success" });
      setImpactOpen(false);
      reset();
      onSaved();
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <AppModal visible={visible && !impactOpen} onClose={handleClose} variant="sheet" backdropAccessibilityLabel={t("common.cancel")}>
        <View style={[styles.header, isRTL && styles.headerRtl]}>
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.freeze.title")}</Text>
        </View>
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.explanation, isRTL && styles.rtl]}>{t("subscriptions.freeze.explanation")}</Text>
          <View style={styles.spaced}>
            <DateRangeFormPanel
              fromLabel={t("subscriptions.freeze.fromLabel")}
              toLabel={t("subscriptions.freeze.untilLabel")}
              start={freezeFrom}
              end={freezeUntil}
              onStartChange={setFreezeFrom}
              onEndChange={setFreezeUntil}
              minimumEnd={freezeFrom ? new Date(freezeFrom) : undefined}
            />
          </View>
          <PrimaryButton label={t("subscriptions.freeze.submit")} onPress={() => void runFreeze(false)} loading={submitting} disabled={submitting} style={styles.submitBtn} />
        </ScrollView>
      </AppModal>
      <SubscriptionImpactConfirmModal
        visible={impactOpen}
        action="freeze"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => void runFreeze(true)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flex: 1 },
  body: { padding: theme.spacing.md },
  explanation: { fontSize: 14, fontWeight: "500", color: theme.colors.textMuted, lineHeight: 21 },
  spaced: { marginTop: theme.spacing.md },
  submitBtn: { marginTop: theme.spacing.lg, marginBottom: theme.spacing.xl },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
