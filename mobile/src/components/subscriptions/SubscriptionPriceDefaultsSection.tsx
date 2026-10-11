import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { supabase } from "../../lib/supabase";
import { PricingSection } from "../PricingSection";
import { PrimaryButton } from "../PrimaryButton";
import { sessionFormStyles as sf } from "../sessionFormStyles";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import {
  fetchGroupPriceDefaults,
  formatPriceInput,
  GROUP_PRICE_DEFAULT_QUOTAS,
  parseDefaultPriceInput,
  saveGroupPriceDefaults,
  type GroupPriceDefaultQuota,
} from "../../lib/subscriptionPriceDefaults";

type Drafts = Record<GroupPriceDefaultQuota, string>;
const EMPTY: Drafts = { 1: "", 2: "", 3: "", 4: "" };

/**
 * Manager settings (Pricing → Subscriptions): default monthly price for 1-4 group sessions a week. Used only to pre-fill
 * the price of a NEW subscription; existing subscriptions and billing never read it. Writes are manager-only server-side
 * (RLS + range checks); an empty field means "no default".
 */
export function SubscriptionPriceDefaultsSection() {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [drafts, setDrafts] = useState<Drafts>(EMPTY);
  const [saved, setSaved] = useState<Drafts>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<Set<GroupPriceDefaultQuota>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const d = await fetchGroupPriceDefaults(supabase);
      const next = { ...EMPTY };
      for (const q of GROUP_PRICE_DEFAULT_QUOTAS) if (d[q] != null) next[q] = formatPriceInput(d[q] as number);
      setDrafts(next);
      setSaved(next);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = GROUP_PRICE_DEFAULT_QUOTAS.some((q) => drafts[q].trim() !== saved[q].trim());

  async function save() {
    if (saving) return;
    const values = {} as Record<GroupPriceDefaultQuota, number | null>;
    const bad = new Set<GroupPriceDefaultQuota>();
    for (const q of GROUP_PRICE_DEFAULT_QUOTAS) {
      const v = parseDefaultPriceInput(drafts[q]);
      if (v === undefined) bad.add(q);
      else values[q] = v;
    }
    setInvalid(bad);
    if (bad.size > 0) return;
    setSaving(true);
    try {
      await saveGroupPriceDefaults(supabase, values);
      showToast({ message: t("subscriptionPricing.saved"), variant: "success" });
      await load();
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PricingSection
      title={t("subscriptionPricing.title")}
      hint={t("subscriptionPricing.hint")}
      isRTL={isRTL}
      loading={loading}
      count={loading || loadFailed ? undefined : GROUP_PRICE_DEFAULT_QUOTAS.length}
      emptyMessage={loadFailed ? t("subscriptionPricing.loadError") : undefined}
      footer={
        !loading && !loadFailed ? (
          <PrimaryButton
            label={t("common.save")}
            onPress={() => void save()}
            loading={saving}
            loadingLabel={t("common.loading")}
            disabled={!dirty}
          />
        ) : undefined
      }
    >
      {GROUP_PRICE_DEFAULT_QUOTAS.map((q) => {
        const label = pluralKey(t, "subscriptionPricing.rowLabel", q).replace("{n}", String(q));
        return (
          <View key={q} style={styles.rowWrap}>
            <View style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl]}>
              <Text style={[styles.label, isRTL && styles.rtl]} numberOfLines={2}>
                {label}
              </Text>
              <View style={[styles.inputWrap, rowFlipFor(isRTL) && styles.rowRtl]}>
                <TextInput
                  value={drafts[q]}
                  onChangeText={(txt) => setDrafts((d) => ({ ...d, [q]: txt }))}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  placeholder={t("subscriptionPricing.notSetPlaceholder")}
                  accessibilityLabel={`${label} (${t("subscriptionPricing.perMonth")})`}
                  style={[sf.control, sf.controlInput, styles.input, isRTL && styles.inputRtl]}
                />
                <Text style={styles.unit}>{t("subscriptionPricing.perMonth")}</Text>
              </View>
            </View>
            {invalid.has(q) ? <Text style={[sf.error, isRTL && styles.rtl]}>{t("subscriptionPricing.invalid")}</Text> : null}
          </View>
        );
      })}
    </PricingSection>
  );
}

const styles = StyleSheet.create({
  rowWrap: { paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  rowRtl: { flexDirection: "row-reverse" },
  label: { flex: 1, minWidth: 0, ...theme.typography.secondary, color: theme.colors.text },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: { width: 110 },
  inputRtl: { textAlign: "right" },
  unit: { ...theme.typography.helper, color: theme.colors.textMuted },
  rtl: { textAlign: "right" },
});
