import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { useDiscardChangesPrompt } from "../../hooks/useDiscardChangesPrompt";
import { supabase } from "../../lib/supabase";
import { sessionFormStyles as sf } from "../sessionFormStyles";
import { AppSwitch } from "../AppSwitch";
import { DatePickerField } from "../DatePickerField";
import { PrimaryButton } from "../PrimaryButton";
import { PayeePickerModal, type PayeePickerRow } from "../PayeePickerModal";
import { formatISODateFull } from "../../lib/dateFormat";
import { toISODateLocal } from "../../lib/isoDate";
import { AllowancesEditor } from "./AllowancesEditor";
import {
  emptyWeeklyLimits,
  rpcCreateSubscription,
  validateCreateSubscriptionInput,
  type WeeklyLimits,
} from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";
import { displayMoney } from "../../lib/displayFormat";
import { useScreenContentStyle } from "../../hooks/useScreenLayout";

/**
 * Full pushed-screen create form, matching CreateSessionForm's shell (sessionFormStyles card
 * sections, footer save + secondary cancel link, discard-changes guard on back navigation) rather
 * than a modal popup — this app presents every creation flow as a screen, not a sheet.
 */
export function CreateSubscriptionForm() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showToast } = useToast();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const [payeePickerOpen, setPayeePickerOpen] = useState(false);
  const [payee, setPayee] = useState<PayeePickerRow | null>(null);
  const [price, setPrice] = useState("");
  const [startDate, setStartDate] = useState(toISODateLocal(new Date()));
  const [noEndDate, setNoEndDate] = useState(true);
  const [endDate, setEndDate] = useState("");
  const [allowances, setAllowances] = useState<WeeklyLimits>(emptyWeeklyLimits());
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const allowLeaveRef = useRef(false);
  const formSerialized = useMemo(
    () => JSON.stringify({ payeeId: payee?.id ?? "", price, startDate, noEndDate, endDate, allowances }),
    [payee, price, startDate, noEndDate, endDate, allowances]
  );
  const baselineRef = useRef(formSerialized);
  const formSerializedRef = useRef(formSerialized);
  formSerializedRef.current = formSerialized;

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current) return;
      if (formSerializedRef.current === baselineRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("sessionForm.unsavedTitle"),
        t("sessionForm.unsavedCreateBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          allowLeaveRef.current = true;
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t, promptDiscardChanges]);

  function confirmLeaveThen(go: () => void) {
    if (formSerializedRef.current === baselineRef.current) {
      allowLeaveRef.current = true;
      go();
      return;
    }
    promptDiscardChanges(
      t("sessionForm.unsavedTitle"),
      t("sessionForm.unsavedCreateBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      () => {
        allowLeaveRef.current = true;
        go();
      }
    );
  }

  const priceNum = Number.parseFloat(price.replace(",", "."));

  const input = useMemo(
    () => ({
      payeeId: payee?.id ?? "",
      payeeIsManual: payee?.kind === "manual",
      monthlyPriceIls: priceNum,
      startDate,
      endDate: noEndDate ? null : endDate || null,
      allowances,
    }),
    [payee, priceNum, startDate, noEndDate, endDate, allowances]
  );

  async function submit() {
    if (submitting) return; // duplicate-submit protection
    const problems = validateCreateSubscriptionInput(input);
    if (problems.length > 0) {
      setErrors(new Set(problems.map((p) => p.field)));
      return;
    }
    setErrors(new Set());
    setSubmitting(true);
    try {
      const res = await rpcCreateSubscription(supabase, input);
      if (!res.ok) {
        const msg = res.error === "conflicting_active_subscription" ? t("subscriptions.create.conflict") : t("subscriptions.genericError");
        showToast({ message: msg, variant: "error" });
        return;
      }
      showToast({ message: t("subscriptions.create.success"), variant: "success" });
      allowLeaveRef.current = true;
      router.replace(`/(app)/manager/subscriptions/${res.subscription_id}`);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const summaryLine = payee && Number.isFinite(priceNum) && priceNum >= 0
    ? t("subscriptions.create.summaryLine")
        .replace("{name}", payee.full_name)
        .replace("{price}", displayMoney(priceNum))
        .replace("{start}", formatISODateFull(startDate, language))
    : null;

  return (
    <>
      <ScrollView contentContainerStyle={[sf.content, screenContent]} style={sf.screen} keyboardShouldPersistTaps="handled">
        <View style={sf.sections}>
          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.create.payeeLabel")}</Text>
            <PrimaryButton
              label={payee ? payee.full_name : t("subscriptions.create.pickPayee")}
              onPress={() => setPayeePickerOpen(true)}
              variant="ghost"
            />
            {errors.has("payee") ? <Text style={[sf.error, isRTL && styles.rtlText]}>{t("subscriptions.errPayeeRequired")}</Text> : null}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.create.priceLabel")}</Text>
            <TextInput
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="0"
              style={[sf.control, sf.controlInput, isRTL && styles.rtlInput]}
            />
            {errors.has("price") ? <Text style={[sf.error, isRTL && styles.rtlText]}>{t("subscriptions.errPriceInvalid")}</Text> : null}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.datesTitle")}</Text>
            <DatePickerField appearance="embedded" label={t("subscriptions.create.startDateLabel")} value={startDate} onChange={setStartDate} />
            {errors.has("startDate") ? <Text style={[sf.error, isRTL && styles.rtlText]}>{t("subscriptions.errStartDateInvalid")}</Text> : null}

            <View style={[styles.toggleRow, styles.spaced, rowFlipFor(isRTL) && styles.toggleRowRtl]}>
              <Text style={[sf.label, isRTL && sf.labelRtl]}>{t("subscriptions.create.noEndDateToggle")}</Text>
              <AppSwitch value={noEndDate} onValueChange={setNoEndDate} accessibilityLabel={t("subscriptions.create.noEndDateToggle")} />
            </View>
            {!noEndDate ? (
              <View style={styles.spaced}>
                <DatePickerField
                  appearance="embedded"
                  label={t("subscriptions.create.endDateLabel")}
                  value={endDate}
                  onChange={setEndDate}
                  minimumDate={startDate ? new Date(startDate) : undefined}
                />
                {errors.has("endDate") ? <Text style={[sf.error, isRTL && styles.rtlText]}>{t("subscriptions.errEndDateInvalid")}</Text> : null}
              </View>
            ) : null}
          </View>

          <View style={sf.card}>
            <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.create.allowancesLabel")}</Text>
            <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl]}>{t("subscriptions.create.allowancesHint")}</Text>
            <AllowancesEditor value={allowances} onChange={setAllowances} label="" />
          </View>

          {summaryLine ? (
            <View style={sf.card}>
              <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("subscriptions.create.summaryTitle")}</Text>
              <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>{summaryLine}</Text>
              <Text style={[styles.summaryLine, isRTL && styles.rtlText]}>
                {noEndDate
                  ? t("subscriptions.create.summaryNoEnd")
                  : endDate
                    ? t("subscriptions.create.summaryEnd").replace("{end}", formatISODateFull(endDate, language))
                    : ""}
              </Text>
            </View>
          ) : null}

          <View style={styles.footer}>
            <PrimaryButton
              label={t("subscriptions.create.submit")}
              onPress={() => void submit()}
              loading={submitting}
              loadingLabel={t("common.loading")}
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
      <PayeePickerModal visible={payeePickerOpen} onClose={() => setPayeePickerOpen(false)} onSelect={setPayee} />
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: theme.spacing.md },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  summaryLine: { fontSize: 14, fontWeight: "600", color: theme.colors.text, lineHeight: 20 },
  footer: { gap: theme.spacing.sm, paddingTop: theme.spacing.xs },
  secondaryAction: { paddingVertical: theme.spacing.sm, alignItems: "center", minHeight: 44, justifyContent: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  rtlText: { textAlign: "right" },
  rtlInput: { textAlign: "right" },
});
