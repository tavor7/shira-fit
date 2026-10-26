import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { useDiscardChangesPrompt } from "../../hooks/useDiscardChangesPrompt";
import { supabase } from "../../lib/supabase";
import { sessionFormStyles as sf } from "../sessionFormStyles";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import { FutureRegistrationsChoiceModal } from "./FutureRegistrationsChoiceModal";
import { rpcStopSubscription, type FutureRegistrationAction, type FutureRegistrationItem, type SubscriptionImpact } from "../../lib/subscriptions";
import { useScreenContentStyle } from "../../hooks/useScreenLayout";

export function StopSubscriptionForm({ subscriptionId }: { subscriptionId: string }) {
  const { t, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showToast } = useToast();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const today = toISODateLocal(new Date());
  const [stopDate, setStopDate] = useState(today);
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);
  const [futureRegs, setFutureRegs] = useState<FutureRegistrationItem[]>([]);
  const [futureRegsOpen, setFutureRegsOpen] = useState(false);
  const [futureRegsNotice, setFutureRegsNotice] = useState<string | undefined>(undefined);

  const allowLeaveRef = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = stopDate !== today;

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || !dirtyRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("sessionForm.unsavedTitle"),
        t("sessionForm.unsavedEditBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          allowLeaveRef.current = true;
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t, promptDiscardChanges]);

  function confirmLeaveThen(go: () => void) {
    if (!dirtyRef.current) {
      allowLeaveRef.current = true;
      go();
      return;
    }
    promptDiscardChanges(
      t("sessionForm.unsavedTitle"),
      t("sessionForm.unsavedEditBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      () => {
        allowLeaveRef.current = true;
        go();
      }
    );
  }

  async function runStop(confirmed: boolean, futureRegistrationAction: FutureRegistrationAction | null = null) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await rpcStopSubscription(
        supabase,
        subscriptionId,
        stopDate,
        confirmed,
        futureRegistrationAction,
        futureRegistrationAction ? futureRegs : null
      );
      if (!res.ok) {
        // The future-registrations list changed (or the staleness check was never satisfied) between
        // the manager's preview and this confirm -- never silently retry with stale/no expectations.
        // Refresh the list from this same response and require an explicit new review + confirm.
        if (res.error === "future_registrations_changed" || res.error === "future_registrations_expectation_required") {
          setFutureRegs(res.future_registrations ?? []);
          setFutureRegsNotice(t("subscriptions.futureRegs.changed"));
          setFutureRegsOpen(true);
          return;
        }
        showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        return;
      }
      if (res.action === "preview") {
        const regs = res.future_registrations ?? [];
        setImpact(res.impact ?? null);
        setFutureRegs(regs);
        setFutureRegsNotice(undefined);
        // No future registrations: go straight to the existing impact dialog (or, if that's also
        // empty, this branch never fires -- the backend only previews when there's something to show).
        if ((res.impact?.count ?? 0) > 0) setImpactOpen(true);
        else if (regs.length > 0) setFutureRegsOpen(true);
        return;
      }
      showToast({ message: t("subscriptions.stop.success"), variant: "success" });
      setImpactOpen(false);
      setFutureRegsOpen(false);
      allowLeaveRef.current = true;
      router.back();
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={[sf.content, screenContent]} style={sf.screen} keyboardShouldPersistTaps="handled">
        <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl, styles.explanation]}>{t("subscriptions.stop.explanation")}</Text>
            <DatePickerField appearance="embedded" label={t("subscriptions.stop.effectiveDateLabel")} value={stopDate} onChange={setStopDate} />
          </View>

          <View style={styles.footer}>
            <PrimaryButton
              label={t("subscriptions.stop.submit")}
              onPress={() => void runStop(false)}
              loading={submitting}
              loadingLabel={t("common.loading")}
              variant="danger"
            />
            <Pressable
              onPress={() => confirmLeaveThen(() => router.back())}
              style={({ pressed }) => [styles.secondaryAction, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
            >
              <Text style={styles.secondaryActionTxt}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
      <SubscriptionImpactConfirmModal
        visible={impactOpen}
        action="stop"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => {
          // Preserves the existing one-step flow when nothing upcoming is affected: only inserts the
          // extra future-registrations step when there actually is one.
          if (futureRegs.length > 0) {
            setImpactOpen(false);
            setFutureRegsOpen(true);
          } else {
            void runStop(true);
          }
        }}
      />
      <FutureRegistrationsChoiceModal
        visible={futureRegsOpen}
        items={futureRegs}
        busy={submitting}
        notice={futureRegsNotice}
        onCancel={() => {
          setFutureRegsOpen(false);
          setFutureRegsNotice(undefined);
        }}
        onConfirm={(action) => void runStop(true, action)}
      />
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  explanation: { marginTop: 0 },
  footer: { gap: theme.spacing.sm, paddingTop: theme.spacing.xs },
  secondaryAction: { paddingVertical: theme.spacing.sm, alignItems: "center", minHeight: 44, justifyContent: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});
