import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useAppAlert } from "../context/AppAlertContext";
import { useI18n } from "../context/I18nContext";
import { PricingIssuesPanel } from "../components/PricingIssuesPanel";
import { PricingCollapsibleList } from "../components/PricingCollapsibleList";
import { PricingFormModal } from "../components/PricingFormModal";
import { PricingSectionAddButton } from "../components/PricingSectionAddButton";
import { PricingSection } from "../components/PricingSection";
import { PricingTierFormFields } from "../components/PricingTierFormFields";
import { PricingRatePeriodFields } from "../components/PricingRatePeriodFields";
import { CoachPickerSheet } from "../components/CoachPickerSheet";
import { PricingPickerField } from "../components/PricingPickerField";
import { pricingScreenStyles as ps } from "../components/pricingScreenStyles";
import type { CoachCapacityPricingRow } from "../types/database";
import { toISODateLocal } from "../lib/isoDate";
import {
  findPricingOverlap,
  formatPricingEffectiveRange,
  filterVisiblePricingGroups,
  flattenPricingGroupsForList,
  groupPricingByCapacity,
  isPricingOverlapDbError,
  sortPricingRows,
  validatePricingPeriodInput,
} from "../lib/pricingRates";
import {
  auditCoachSessionPricingIssues,
  detectNoPricingConfigured,
  detectPricingCoverageGaps,
  detectPricingOverlaps,
  mergePricingIssues,
  type PricingIssue,
} from "../lib/pricingIssues";

type Props = {
  /** Manager: show coach picker. Ignored when lockedCoachId is set. */
  allowCoachPicker?: boolean;
  /** Coach (or manager editing self): fixed coach user id. */
  lockedCoachId?: string | null;
  hideIntro?: boolean;
};

export default function CoachCapacityPricingScreen({
  allowCoachPicker = false,
  lockedCoachId = null,
  hideIntro = false,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const { showConfirm, showOk } = useAppAlert();
  const [pickedCoachId, setPickedCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [capStr, setCapStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [fromStr, setFromStr] = useState(() => toISODateLocal(new Date()));
  const [toStr, setToStr] = useState("");
  const [rows, setRows] = useState<CoachCapacityPricingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editRow, setEditRow] = useState<{ id: string; cap: number } | null>(null);
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [auditIssues, setAuditIssues] = useState<PricingIssue[]>([]);

  const coachId = lockedCoachId ?? pickedCoachId;

  const load = useCallback(async () => {
    if (!coachId) {
      setRows([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("coach_capacity_pricing")
      .select("id, coach_id, max_participants, price_ils, effective_from, effective_to, updated_at")
      .eq("coach_id", coachId)
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      showOk(t("common.error"), error.message);
      setRows([]);
      return;
    }
    setRows(sortPricingRows((data as CoachCapacityPricingRow[]) ?? []));
  }, [coachId, t]);

  useEffect(() => {
    if (lockedCoachId) {
      setPickedCoachId(lockedCoachId);
      setCoachLabel("");
    }
  }, [lockedCoachId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setEditRow(null);
    setCapStr("");
    setPriceStr("");
    setFromStr(toISODateLocal(new Date()));
    setToStr("");
    setFormModalOpen(false);
  }, [coachId]);

  function notifyErr(message: string) {
    showOk(t("common.error"), message);
  }

  async function saveRule() {
    if (!coachId) {
      showPickCoach();
      return;
    }
    const cap = Number.parseInt(capStr.trim(), 10);
    if (!Number.isFinite(cap) || cap < 1) {
      notifyErr(t("pricing.invalidCapacity"));
      return;
    }
    const price = Number.parseFloat(priceStr.replace(",", ".").trim());
    if (!Number.isFinite(price) || price < 0) {
      notifyErr(t("pricing.invalidPrice"));
      return;
    }
    const period = validatePricingPeriodInput(fromStr, toStr);
    if (!period.ok) {
      notifyErr(t(period.errorKey));
      return;
    }
    const overlap = findPricingOverlap(
      { effective_from: period.effective_from, effective_to: period.effective_to },
      rows,
      { excludeId: editRow?.id, sameTier: (r) => r.max_participants === cap }
    );
    if (overlap) {
      notifyErr(t("pricing.periodOverlap"));
      return;
    }
    setSaving(true);
    const payload = {
      coach_id: coachId,
      max_participants: cap,
      price_ils: price,
      effective_from: period.effective_from,
      effective_to: period.effective_to,
    };
    let error;
    if (editRow?.id) {
      ({ error } = await supabase.from("coach_capacity_pricing").update(payload).eq("id", editRow.id));
    } else {
      ({ error } = await supabase.from("coach_capacity_pricing").insert(payload));
    }
    setSaving(false);
    if (error) {
      notifyErr(isPricingOverlapDbError(error.message) ? t("pricing.periodOverlap") : error.message);
      return;
    }
    setCapStr("");
    setPriceStr("");
    setFromStr(toISODateLocal(new Date()));
    setToStr("");
    setEditRow(null);
    setFormModalOpen(false);
    await load();
  }

  function openAdd() {
    if (!coachId) {
      showPickCoach();
      return;
    }
    setEditRow(null);
    setCapStr("");
    setPriceStr("");
    setFromStr(toISODateLocal(new Date()));
    setToStr("");
    setFormModalOpen(true);
  }

  function startEdit(row: CoachCapacityPricingRow) {
    if (!row.id) return;
    setEditRow({ id: row.id, cap: row.max_participants });
    setCapStr(String(row.max_participants));
    setPriceStr(String(row.price_ils));
    setFromStr(row.effective_from ?? toISODateLocal(new Date()));
    setToStr(row.effective_to ?? "");
    setFormModalOpen(true);
  }

  function cancelEdit() {
    setEditRow(null);
    setCapStr("");
    setPriceStr("");
    setFromStr(toISODateLocal(new Date()));
    setToStr("");
    setFormModalOpen(false);
  }

  const formatRange = useCallback(
    (from?: string, to?: string | null) => {
      if (!from) return "—";
      return formatPricingEffectiveRange(from, to, language, t("pricing.effectivePresent"));
    },
    [language, t]
  );

  const capTitle = useCallback(
    (cap: number) => t("coachPricing.tierListCaption").replace("{n}", String(cap)),
    [t]
  );

  const staticIssues = useMemo(() => {
    if (!coachId) return [];
    return mergePricingIssues(
      detectPricingOverlaps(rows, "coach", capTitle, formatRange),
      detectPricingCoverageGaps(rows, "coach", capTitle, formatRange),
      detectNoPricingConfigured(
        rows,
        "coach",
        coachLabel ? `${coachLabel} · ${t("coachPricing.ratesSection")}` : t("coachPricing.ratesSection")
      )
    );
  }, [coachId, coachLabel, rows, capTitle, formatRange, t]);

  useEffect(() => {
    if (!coachId || loading) {
      setAuditIssues([]);
      return;
    }
    let cancelled = false;
    void auditCoachSessionPricingIssues({
      supabase,
      coachId,
      coachRows: rows,
      language,
    }).then((issues) => {
      if (!cancelled) setAuditIssues(issues);
    });
    return () => {
      cancelled = true;
    };
  }, [coachId, rows, language, loading]);

  const pricingIssues = useMemo(
    () => mergePricingIssues(staticIssues, auditIssues),
    [staticIssues, auditIssues]
  );

  function applyPricingFix(issue: PricingIssue) {
    const fix = issue.fix;
    if (!fix) return;
    if (fix.type === "edit_rate" && fix.section === "coach") {
      const row = rows.find((r) => r.id === fix.rateId);
      if (row) startEdit(row);
      return;
    }
    if (fix.type === "add_rate" && fix.section === "coach") {
      setEditRow(null);
      setCapStr(fix.maxParticipants != null ? String(fix.maxParticipants) : "");
      setPriceStr("");
      setFromStr(fix.effectiveFrom ?? toISODateLocal(new Date()));
      setToStr("");
      setFormModalOpen(true);
    }
  }

  const showEndedLabel = useCallback(
    (n: number) => t("pricing.showEndedRates").replace(/\{n\}/g, String(n)),
    [t]
  );

  const capacityGroups = useMemo(
    () => filterVisiblePricingGroups(groupPricingByCapacity(rows)),
    [rows]
  );

  const listRows = useMemo(
    () => flattenPricingGroupsForList(capacityGroups, capTitle),
    [capacityGroups, capTitle]
  );

  const formTitle = editRow !== null ? t("pricing.editRule") : t("pricing.addRule");

  function showPickCoach() {
    showOk(t("common.error"), t("pricing.chooseCoachFirst"));
  }

  function confirmRemove(row: CoachCapacityPricingRow) {
    if (!coachId || !row.id) {
      showPickCoach();
      return;
    }
    showConfirm({
      title: t("pricing.removeAthleteRateTitle"),
      message: t("pricing.confirmRemoveGlobalMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("pricing.delete"),
      confirmVariant: "danger",
      onConfirm: () => {
        void (async () => {
          await supabase.from("coach_capacity_pricing").delete().eq("id", row.id);
          if (editRow?.id === row.id) cancelEdit();
          await load();
        })();
      },
    });
  }

  const body = (
    <>
      {coachId ? <PricingIssuesPanel issues={pricingIssues} onFix={applyPricingFix} isRTL={isRTL} /> : null}

      {allowCoachPicker && !lockedCoachId ? (
        <View style={styles.coachPickCard}>
          <PricingPickerField
            label={t("sessionForm.trainer")}
            value={coachLabel}
            placeholder={t("sessionForm.chooseTrainer")}
            onPress={() => setPickerOpen(true)}
            isRTL={isRTL}
            accessibilityLabel={t("sessionForm.trainer")}
          />
        </View>
      ) : null}

      <View style={!coachId ? styles.disabledWrap : undefined}>
        <PricingSection
          title={t("coachPricing.ratesSection")}
          isRTL={isRTL}
          loading={!!coachId && loading}
          emptyMessage={
            !coachId
              ? language === "he"
                ? "בחרו מאמן כדי לערוך תעריפים."
                : "Pick a coach to edit rates."
              : !loading && capacityGroups.length === 0
                ? t("pricing.empty")
                : undefined
          }
          count={coachId ? capacityGroups.length : undefined}
          headerAction={
            <PricingSectionAddButton
              label={t("pricing.addRule")}
              onPress={openAdd}
              isRTL={isRTL}
              disabled={!coachId}
            />
          }
        >
          <PricingCollapsibleList
            rows={listRows}
            clusterMode="groupKey"
            showEndedLabel={showEndedLabel}
            hideEndedLabel={t("pricing.hideEndedRates")}
            editLabel={t("common.edit")}
            removeLabel={t("pricing.delete")}
            moreMenuLabel={t("pricing.moreMenu")}
            closeLabel={t("common.cancel")}
            onEdit={(r) => startEdit(r)}
            onRemove={(r) => confirmRemove(r)}
            isRTL={isRTL}
          />
        </PricingSection>
      </View>

      <PricingFormModal
        visible={formModalOpen}
        title={formTitle}
        onClose={cancelEdit}
        saveLabel={t("common.save")}
        onSave={() => void saveRule()}
        saving={saving}
        loadingLabel={t("common.loading")}
        cancelLabel={t("common.cancel")}
        isRTL={isRTL}
      >
        <PricingTierFormFields
          capacityLabel={t("coachPricing.tierFieldLabel")}
          priceLabel={t("coachPricing.sessionPayout")}
          capValue={capStr}
          priceValue={priceStr}
          onCapChange={setCapStr}
          onPriceChange={setPriceStr}
          capPlaceholder="8"
          pricePlaceholder="40"
          editable={!!coachId}
          isRTL={isRTL}
        />
        <PricingRatePeriodFields
          fromLabel={t("pricing.effectiveFrom")}
          toLabel={t("pricing.effectiveTo")}
          toHint={t("pricing.effectiveToHint")}
          fromValue={fromStr}
          toValue={toStr}
          onFromChange={setFromStr}
          onToChange={setToStr}
          isRTL={isRTL}
        />
      </PricingFormModal>

      <CoachPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedCoachId={pickedCoachId}
        onSelect={(coach) => {
          setPickedCoachId(coach.user_id);
          setCoachLabel(coach.full_name);
          cancelEdit();
        }}
      />
    </>
  );

  if (hideIntro) {
    return <View style={ps.embedded}>{body}</View>;
  }

  return (
    <ScrollView style={ps.screen} contentContainerStyle={ps.content} keyboardShouldPersistTaps="handled">
      <Text style={[ps.intro, isRTL && ps.rtl]}>{t("coachPricing.titleHint")}</Text>
      {body}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  coachPickCard: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.sm,
  },
  disabledWrap: { opacity: 0.55 },
});
