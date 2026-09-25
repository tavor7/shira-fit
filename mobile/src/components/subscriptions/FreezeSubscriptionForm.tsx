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
import { DateRangeFormPanel } from "../DateRangeFormPanel";
import { PrimaryButton } from "../PrimaryButton";
import { toISODateLocal } from "../../lib/isoDate";
import { SubscriptionImpactConfirmModal } from "./SubscriptionImpactConfirmModal";
import { rpcFreezeSubscription, type SubscriptionImpact } from "../../lib/subscriptions";

export function FreezeSubscriptionForm({ subscriptionId }: { subscriptionId: string }) {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const today = toISODateLocal(new Date());
  const [freezeFrom, setFreezeFrom] = useState(today);
  const [freezeUntil, setFreezeUntil] = useState(today);
  const [submitting, setSubmitting] = useState(false);
  const [impact, setImpact] = useState<SubscriptionImpact | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);

  const allowLeaveRef = useRef(false);
  const dirty = freezeFrom !== today || freezeUntil !== today;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

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
      <ScrollView contentContainerStyle={sf.content} style={sf.screen} keyboardShouldPersistTaps="handled">
        <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl, styles.explanation]}>{t("subscriptions.freeze.explanation")}</Text>
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

          <View style={styles.footer}>
            <PrimaryButton label={t("subscriptions.freeze.submit")} onPress={() => void runFreeze(false)} loading={submitting} loadingLabel={t("common.loading")} />
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
        action="freeze"
        impact={impact}
        busy={submitting}
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => void runFreeze(true)}
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
