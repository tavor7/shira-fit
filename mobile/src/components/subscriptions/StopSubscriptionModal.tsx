import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { AppModal } from "../AppModal";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import { rpcStopSubscription, type SubscriptionImpact } from "../../lib/subscriptions";

type Props = {
  visible: boolean;
  subscriptionId: string;
  onClose: () => void;
  onSaved: () => void;
};

export function StopSubscriptionModal({ visible, subscriptionId, onClose, onSaved }: Props) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();

  const [stopDate, setStopDate] = useState(toISODateLocal(new Date()));
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);

  function reset() {
    setStopDate(toISODateLocal(new Date()));
    setSubmitting(false);
    setImpact(null);
    setImpactOpen(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function runStop(confirmed: boolean) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await rpcStopSubscription(supabase, subscriptionId, stopDate, confirmed);
      if (!res.ok) {
        showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        return;
      }
      if (res.action === "preview") {
        setImpact(res.impact ?? null);
        setImpactOpen(true);
        return;
      }
      showToast({ message: t("subscriptions.stop.success"), variant: "success" });
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
          <Text style={[styles.title, isRTL && styles.rtl]}>{t("subscriptions.stop.title")}</Text>
        </View>
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.explanation, isRTL && styles.rtl]}>{t("subscriptions.stop.explanation")}</Text>
          <View style={styles.spaced}>
            <DatePickerField appearance="standalone" label={t("subscriptions.stop.effectiveDateLabel")} value={stopDate} onChange={setStopDate} />
          </View>
          <PrimaryButton
            label={t("subscriptions.stop.submit")}
            onPress={() => void runStop(false)}
            loading={submitting}
            disabled={submitting}
            variant="danger"
            style={styles.submitBtn}
          />
        </ScrollView>
      </AppModal>
      <SubscriptionImpactConfirmModal
        visible={impactOpen}
        action="stop"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => void runStop(true)}
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
