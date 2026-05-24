import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
  Alert,
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useAppAlert } from "../context/AppAlertContext";
import { useI18n } from "../context/I18nContext";
import { PricingSection } from "../components/PricingSection";
import { PricingCollapsibleList } from "../components/PricingCollapsibleList";
import { PricingFormModal } from "../components/PricingFormModal";
import { PricingSectionAddButton } from "../components/PricingSectionAddButton";
import { PricingTierFormFields } from "../components/PricingTierFormFields";
import { PricingRatePeriodFields } from "../components/PricingRatePeriodFields";
import { PricingPickerField } from "../components/PricingPickerField";
import { AppSearchField } from "../components/AppSearchField";
import { AppSearchSheet } from "../components/AppSearchSheet";
import { pricingScreenStyles as ps } from "../components/pricingScreenStyles";
import type { AthleteSessionCapacityPricingRow, SessionCapacityPricingRow } from "../types/database";
import { toISODateLocal } from "../lib/isoDate";
import {
  findPricingOverlap,
  formatPricingEffectiveRange,
  clusterPricingListRows,
  filterVisiblePricingGroups,
  flattenPricingGroupsForList,
  groupAthletePricingRows,
  groupPricingByCapacity,
  isPricingOverlapDbError,
  sortPricingRows,
  validatePricingPeriodInput,
} from "../lib/pricingRates";

type Props = { hideIntro?: boolean };

type AthletePick =
  | { kind: "athlete"; user_id: string; full_name: string; username: string; phone?: string | null }
  | { kind: "quick"; id: string; full_name: string; phone: string; linked_user_id: string | null };

type OverrideRow = AthleteSessionCapacityPricingRow & {
  profiles?: { full_name: string } | { full_name: string }[] | null;
  manual_participants?: { full_name: string } | { full_name: string }[] | null;
};

function parseTierCapacity(raw: string): number | null {
  const cap = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(cap) && cap >= 1 ? cap : null;
}

function parseMoneyInput(raw: string): number | null {
  const price = Number.parseFloat(raw.replace(",", ".").trim());
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function alertNative(title: string, message: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") window.alert(message);
  else Alert.alert(title, message);
}

export default function SessionPricingScreen({ hideIntro = false }: Props) {
  const { t, language, isRTL } = useI18n();
  const { showConfirm } = useAppAlert();
  const [capStr, setCapStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [globalFromStr, setGlobalFromStr] = useState(() => toISODateLocal(new Date()));
  const [globalToStr, setGlobalToStr] = useState("");
  const [rows, setRows] = useState<SessionCapacityPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [pickedUserId, setPickedUserId] = useState("");
  const [pickedManualId, setPickedManualId] = useState("");
  const [pickedAthleteLabel, setPickedAthleteLabel] = useState("");
  const [athCapStr, setAthCapStr] = useState("");
  const [athPriceStr, setAthPriceStr] = useState("");
  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([]);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [athletes, setAthletes] = useState<AthletePick[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);

  const [kickboxCapStr, setKickboxCapStr] = useState("");
  const [kickboxPriceStr, setKickboxPriceStr] = useState("");
  const [kickboxFromStr, setKickboxFromStr] = useState(() => toISODateLocal(new Date()));
  const [kickboxToStr, setKickboxToStr] = useState("");
  const [athFromStr, setAthFromStr] = useState(() => toISODateLocal(new Date()));
  const [athToStr, setAthToStr] = useState("");
  const [kickboxRows, setKickboxRows] = useState<SessionCapacityPricingRow[]>([]);
  const [kickboxSaving, setKickboxSaving] = useState(false);
  const [editGlobal, setEditGlobal] = useState<{ id: string; cap: number; isKickbox: boolean } | null>(null);
  const [editAthlete, setEditAthlete] = useState<{
    id?: string;
    userId?: string;
    manualId?: string;
    cap: number;
  } | null>(null);
  const [globalModalOpen, setGlobalModalOpen] = useState(false);
  const [athleteModalOpen, setAthleteModalOpen] = useState(false);
  const [kickboxModalOpen, setKickboxModalOpen] = useState(false);

  const notifyErr = useCallback(
    (message: string) => {
      alertNative(t("common.error"), message);
    },
    [t]
  );

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("session_capacity_pricing")
      .select("id, max_participants, price_ils, is_kickbox, effective_from, effective_to, updated_at")
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      notifyErr(error.message);
      setRows([]);
      setKickboxRows([]);
      return;
    }
    const list = sortPricingRows((data as SessionCapacityPricingRow[]) ?? []);
    setRows(list.filter((r) => !r.is_kickbox));
    setKickboxRows(list.filter((r) => !!r.is_kickbox));
  }, [notifyErr]);

  const loadOverrides = useCallback(async () => {
    setOverrideLoading(true);
    const { data, error } = await supabase
      .from("athlete_session_capacity_pricing")
      .select(
        "id, user_id, manual_participant_id, max_participants, price_ils, effective_from, effective_to, updated_at, profiles(full_name), manual_participants(full_name)"
      )
      .order("max_participants", { ascending: true });
    setOverrideLoading(false);
    if (error) {
      notifyErr(error.message);
      setOverrideRows([]);
      return;
    }
    const list = (data as OverrideRow[]) ?? [];
    list.sort((a, b) => {
      const na = resolveOverrideName(a).localeCompare(resolveOverrideName(b));
      if (na !== 0) return na;
      if (a.max_participants !== b.max_participants) return a.max_participants - b.max_participants;
      return (b.effective_from ?? "").localeCompare(a.effective_from ?? "");
    });
    setOverrideRows(list);
  }, [notifyErr]);

  const loadAthletes = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;

    let mQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      mQuery = mQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data: mData, error: mErr } = await mQuery;

    setAthletesLoading(false);
    if (error) {
      setAthletes([]);
      return;
    }
    const base = ((data as { user_id: string; full_name: string; username: string; phone?: string | null }[]) ?? []).map(
      (a) => ({ kind: "athlete" as const, ...a })
    );
    const quick = mErr
      ? []
      : ((mData as { id: string; full_name: string; phone: string; linked_user_id: string | null }[]) ?? []).map((m) => ({
          kind: "quick" as const,
          ...m,
        }));
    const seen = new Set(
      ((data as { user_id: string }[] | null) ?? []).map((a) => a.user_id)
    );
    const quickDedup = quick.filter((m) => (m.linked_user_id ? !seen.has(m.linked_user_id) : true));
    setAthletes([...quickDedup, ...base]);
  }, []);

  useEffect(() => {
    void load();
    void loadOverrides();
  }, [load, loadOverrides]);

  function selectAthletePick(item: AthletePick) {
    if (item.kind === "athlete") {
      setPickedUserId(item.user_id);
      setPickedManualId("");
      setPickedAthleteLabel(`${item.full_name} (@${item.username})`);
      setPickerOpen(false);
      return;
    }
    if (item.linked_user_id) {
      setPickedUserId(item.linked_user_id);
      setPickedManualId("");
    } else {
      setPickedUserId("");
      setPickedManualId(item.id);
    }
    setPickedAthleteLabel(`${item.full_name} · ${item.phone}`);
    setPickerOpen(false);
  }

  async function saveGlobalRule(isKickbox: boolean) {
    const capRaw = isKickbox ? kickboxCapStr : capStr;
    const priceRaw = isKickbox ? kickboxPriceStr : priceStr;
    const fromRaw = isKickbox ? kickboxFromStr : globalFromStr;
    const toRaw = isKickbox ? kickboxToStr : globalToStr;
    const cap = parseTierCapacity(capRaw);
    if (cap === null) {
      notifyErr(t("pricing.invalidCapacity"));
      return;
    }
    const price = parseMoneyInput(priceRaw);
    if (price === null) {
      notifyErr(t("pricing.invalidPrice"));
      return;
    }
    const period = validatePricingPeriodInput(fromRaw, toRaw);
    if (!period.ok) {
      notifyErr(t(period.errorKey));
      return;
    }
    const editing = editGlobal?.isKickbox === isKickbox ? editGlobal : null;
    const pool = isKickbox ? kickboxRows : rows;
    const overlap = findPricingOverlap(
      { effective_from: period.effective_from, effective_to: period.effective_to },
      pool,
      { excludeId: editing?.id, sameTier: (r) => r.max_participants === cap }
    );
    if (overlap) {
      notifyErr(t("pricing.periodOverlap"));
      return;
    }
    const setBusy = isKickbox ? setKickboxSaving : setSaving;
    setBusy(true);
    const payload = {
      max_participants: cap,
      price_ils: price,
      is_kickbox: isKickbox,
      effective_from: period.effective_from,
      effective_to: period.effective_to,
    };
    let error;
    if (editing?.id) {
      ({ error } = await supabase.from("session_capacity_pricing").update(payload).eq("id", editing.id));
    } else {
      ({ error } = await supabase.from("session_capacity_pricing").insert(payload));
    }
    setBusy(false);
    if (error) {
      notifyErr(isPricingOverlapDbError(error.message) ? t("pricing.periodOverlap") : error.message);
      return;
    }
    if (isKickbox) {
      setKickboxCapStr("");
      setKickboxPriceStr("");
      setKickboxFromStr(toISODateLocal(new Date()));
      setKickboxToStr("");
    } else {
      setCapStr("");
      setPriceStr("");
      setGlobalFromStr(toISODateLocal(new Date()));
      setGlobalToStr("");
    }
    setEditGlobal(null);
    if (isKickbox) setKickboxModalOpen(false);
    else setGlobalModalOpen(false);
    await load();
  }

  function openAddGlobal(isKickbox: boolean) {
    setEditGlobal(null);
    setGlobalModalOpen(false);
    setKickboxModalOpen(false);
    setAthleteModalOpen(false);
    if (isKickbox) {
      setKickboxCapStr("");
      setKickboxPriceStr("");
      setKickboxFromStr(toISODateLocal(new Date()));
      setKickboxToStr("");
      setKickboxModalOpen(true);
    } else {
      setCapStr("");
      setPriceStr("");
      setGlobalFromStr(toISODateLocal(new Date()));
      setGlobalToStr("");
      setGlobalModalOpen(true);
    }
  }

  function startEditGlobal(row: SessionCapacityPricingRow, isKickbox: boolean) {
    if (!row.id) return;
    setEditGlobal({ id: row.id, cap: row.max_participants, isKickbox });
    setAthleteModalOpen(false);
    if (isKickbox) {
      setKickboxModalOpen(true);
      setGlobalModalOpen(false);
    } else {
      setGlobalModalOpen(true);
      setKickboxModalOpen(false);
    }
    const from = row.effective_from ?? toISODateLocal(new Date());
    const to = row.effective_to ?? "";
    if (isKickbox) {
      setKickboxCapStr(String(row.max_participants));
      setKickboxPriceStr(String(row.price_ils));
      setKickboxFromStr(from);
      setKickboxToStr(to);
    } else {
      setCapStr(String(row.max_participants));
      setPriceStr(String(row.price_ils));
      setGlobalFromStr(from);
      setGlobalToStr(to);
    }
  }

  function cancelEditGlobal(isKickbox: boolean) {
    if (editGlobal?.isKickbox === isKickbox) setEditGlobal(null);
    if (isKickbox) {
      setKickboxCapStr("");
      setKickboxPriceStr("");
      setKickboxFromStr(toISODateLocal(new Date()));
      setKickboxToStr("");
      setKickboxModalOpen(false);
    } else {
      setCapStr("");
      setPriceStr("");
      setGlobalFromStr(toISODateLocal(new Date()));
      setGlobalToStr("");
      setGlobalModalOpen(false);
    }
  }

  function openAddAthlete() {
    setEditAthlete(null);
    setPickedUserId("");
    setPickedManualId("");
    setPickedAthleteLabel("");
    setAthCapStr("");
    setAthPriceStr("");
    setAthFromStr(toISODateLocal(new Date()));
    setAthToStr("");
    setGlobalModalOpen(false);
    setKickboxModalOpen(false);
    setAthleteModalOpen(true);
  }

  async function saveAthleteRule() {
    if (!pickedUserId && !pickedManualId) {
      notifyErr(t("pricing.chooseAthleteFirst"));
      return;
    }
    const cap = parseTierCapacity(athCapStr);
    if (cap === null) {
      notifyErr(t("pricing.invalidCapacity"));
      return;
    }
    const price = parseMoneyInput(athPriceStr);
    if (price === null) {
      notifyErr(t("pricing.invalidPrice"));
      return;
    }
    const period = validatePricingPeriodInput(athFromStr, athToStr);
    if (!period.ok) {
      notifyErr(t(period.errorKey));
      return;
    }
    const isManual = !!pickedManualId;
    const overlap = findPricingOverlap<OverrideRow>(
      { effective_from: period.effective_from, effective_to: period.effective_to },
      overrideRows,
      {
        excludeId: editAthlete?.id,
        sameTier: (r) =>
          r.max_participants === cap &&
          (isManual
            ? r.manual_participant_id === pickedManualId
            : r.user_id === pickedUserId && !r.manual_participant_id),
      }
    );
    if (overlap) {
      notifyErr(t("pricing.periodOverlap"));
      return;
    }
    setOverrideSaving(true);
    const row = isManual
      ? {
          user_id: null,
          manual_participant_id: pickedManualId,
          max_participants: cap,
          price_ils: price,
          effective_from: period.effective_from,
          effective_to: period.effective_to,
        }
      : {
          user_id: pickedUserId,
          manual_participant_id: null,
          max_participants: cap,
          price_ils: price,
          effective_from: period.effective_from,
          effective_to: period.effective_to,
        };

    let error;
    if (editAthlete?.id) {
      ({ error } = await supabase.from("athlete_session_capacity_pricing").update(row).eq("id", editAthlete.id));
    } else {
      ({ error } = await supabase.from("athlete_session_capacity_pricing").insert(row));
    }
    setOverrideSaving(false);
    if (error) {
      notifyErr(isPricingOverlapDbError(error.message) ? t("pricing.periodOverlap") : error.message);
      return;
    }
    setAthCapStr("");
    setAthPriceStr("");
    setAthFromStr(toISODateLocal(new Date()));
    setAthToStr("");
    setPickedUserId("");
    setPickedManualId("");
    setPickedAthleteLabel("");
    setEditAthlete(null);
    setAthleteModalOpen(false);
    await loadOverrides();
  }

  function startEditAthlete(row: OverrideRow) {
    const name = resolveOverrideName(row);
    setGlobalModalOpen(false);
    setKickboxModalOpen(false);
    setAthleteModalOpen(true);
    if (row.manual_participant_id) {
      setEditAthlete({
        id: row.id,
        manualId: row.manual_participant_id,
        cap: row.max_participants,
      });
      setPickedManualId(row.manual_participant_id);
      setPickedUserId("");
    } else {
      setEditAthlete({
        id: row.id,
        userId: row.user_id ?? undefined,
        cap: row.max_participants,
      });
      setPickedUserId(row.user_id ?? "");
      setPickedManualId("");
    }
    setPickedAthleteLabel(name);
    setAthCapStr(String(row.max_participants));
    setAthPriceStr(String(row.price_ils));
    setAthFromStr(row.effective_from ?? toISODateLocal(new Date()));
    setAthToStr(row.effective_to ?? "");
  }

  function cancelEditAthlete() {
    setEditAthlete(null);
    setPickedUserId("");
    setPickedManualId("");
    setPickedAthleteLabel("");
    setAthCapStr("");
    setAthPriceStr("");
    setAthFromStr(toISODateLocal(new Date()));
    setAthToStr("");
    setAthleteModalOpen(false);
  }

  function confirmRemoveGlobal(row: SessionCapacityPricingRow, isKickbox: boolean) {
    if (!row.id) return;
    showConfirm({
      title: t("pricing.removeAthleteRateTitle"),
      message: t("pricing.confirmRemoveGlobalMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("pricing.delete"),
      confirmVariant: "danger",
      onConfirm: () => {
        void (async () => {
          await supabase.from("session_capacity_pricing").delete().eq("id", row.id);
          if (editGlobal?.id === row.id) cancelEditGlobal(isKickbox);
          await load();
        })();
      },
    });
  }

  function confirmRemoveOverride(row: OverrideRow, athleteLabelText: string) {
    if (!row.id) return;
    showConfirm({
      title: t("pricing.removeAthleteRateTitle"),
      message: t("pricing.removeAthleteRateConfirm").replace(/\{name\}/g, athleteLabelText),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("pricing.delete"),
      confirmVariant: "danger",
      onConfirm: () => {
        void (async () => {
          await supabase.from("athlete_session_capacity_pricing").delete().eq("id", row.id);
          if (editAthlete?.id === row.id) cancelEditAthlete();
          await loadOverrides();
        })();
      },
    });
  }

  const formatRange = useCallback(
    (from?: string, to?: string | null) => {
      if (!from) return "—";
      return formatPricingEffectiveRange(from, to, language, t("pricing.effectivePresent"));
    },
    [language, t]
  );

  const showEndedLabel = useCallback(
    (n: number) => t("pricing.showEndedRates").replace(/\{n\}/g, String(n)),
    [t]
  );

  const globalGroups = useMemo(
    () => filterVisiblePricingGroups(groupPricingByCapacity(rows)),
    [rows]
  );
  const kickboxGroups = useMemo(
    () => filterVisiblePricingGroups(groupPricingByCapacity(kickboxRows)),
    [kickboxRows]
  );
  const athleteGroups = useMemo(
    () => filterVisiblePricingGroups(groupAthletePricingRows(overrideRows, resolveOverrideName)),
    [overrideRows]
  );

  const capTitle = useCallback(
    (cap: number) => `${cap} ${t("pricing.participantsLabel")}`,
    [t]
  );

  const globalListRows = useMemo(
    () => flattenPricingGroupsForList(globalGroups, capTitle),
    [globalGroups, capTitle]
  );
  const kickboxListRows = useMemo(
    () => flattenPricingGroupsForList(kickboxGroups, capTitle),
    [kickboxGroups, capTitle]
  );
  const athleteListRows = useMemo(
    () =>
      flattenPricingGroupsForList(
        athleteGroups.map((g) => ({ capacity: g.capacity, label: g.label, periods: g.periods })),
        capTitle
      ),
    [athleteGroups, capTitle]
  );

  const listRowProps = {
    showEndedLabel,
    hideEndedLabel: t("pricing.hideEndedRates"),
    editLabel: t("common.edit"),
    removeLabel: t("pricing.delete"),
    moreMenuLabel: t("pricing.moreMenu"),
    closeLabel: t("common.cancel"),
    isRTL,
  };

  const athleteClusterCount = useMemo(
    () => clusterPricingListRows(athleteListRows, "title").length,
    [athleteListRows]
  );

  const globalFormTitle =
    editGlobal && !editGlobal.isKickbox ? t("pricing.editRule") : t("pricing.addRule");
  const athleteFormTitle = editAthlete ? t("pricing.editRule") : t("pricing.addAthleteRate");
  const kickboxFormTitle = editGlobal?.isKickbox ? t("pricing.editRule") : t("pricing.addRule");

  const body = (
    <>
      <PricingSection
        title={t("pricing.standardSection")}
        isRTL={isRTL}
        loading={loading}
        emptyMessage={!loading && globalGroups.length === 0 ? t("pricing.empty") : undefined}
        count={globalGroups.length}
        headerAction={
          <PricingSectionAddButton label={t("pricing.addRule")} onPress={() => openAddGlobal(false)} isRTL={isRTL} />
        }
      >
        <PricingCollapsibleList
          rows={globalListRows}
          clusterMode="groupKey"
          {...listRowProps}
          onEdit={(r) => startEditGlobal(r, false)}
          onRemove={(r) => confirmRemoveGlobal(r, false)}
        />
      </PricingSection>

      <PricingSection
        title={t("pricing.specialAthleteSection")}
        isRTL={isRTL}
        loading={overrideLoading}
        emptyMessage={!overrideLoading && athleteGroups.length === 0 ? t("pricing.specialAthleteEmpty") : undefined}
        count={athleteClusterCount}
        headerAction={
          <PricingSectionAddButton label={t("pricing.addAthleteRate")} onPress={openAddAthlete} isRTL={isRTL} />
        }
      >
        <PricingCollapsibleList
          rows={athleteListRows}
          clusterMode="title"
          {...listRowProps}
          onEdit={(r) => startEditAthlete(r)}
          onRemove={(r) => {
            const name = resolveOverrideName(r as OverrideRow);
            confirmRemoveOverride(r as OverrideRow, name);
          }}
        />
      </PricingSection>

      <PricingSection
        title={t("pricing.kickboxGlobalSection")}
        isRTL={isRTL}
        loading={loading}
        emptyMessage={!loading && kickboxGroups.length === 0 ? t("pricing.kickboxGlobalEmpty") : undefined}
        count={kickboxGroups.length}
        headerAction={
          <PricingSectionAddButton label={t("pricing.addRule")} onPress={() => openAddGlobal(true)} isRTL={isRTL} />
        }
      >
        <PricingCollapsibleList
          rows={kickboxListRows}
          clusterMode="groupKey"
          {...listRowProps}
          onEdit={(r) => startEditGlobal(r, true)}
          onRemove={(r) => confirmRemoveGlobal(r, true)}
        />
      </PricingSection>

      <PricingFormModal
        visible={globalModalOpen}
        title={globalFormTitle}
        onClose={() => cancelEditGlobal(false)}
        saveLabel={t("common.save")}
        onSave={() => void saveGlobalRule(false)}
        saving={saving}
        loadingLabel={t("common.loading")}
        cancelLabel={t("common.cancel")}
        isRTL={isRTL}
      >
        <PricingTierFormFields
          capacityLabel={t("pricing.capacity")}
          priceLabel={t("pricing.price")}
          capValue={capStr}
          priceValue={priceStr}
          onCapChange={setCapStr}
          onPriceChange={setPriceStr}
          isRTL={isRTL}
        />
        <PricingRatePeriodFields
          fromLabel={t("pricing.effectiveFrom")}
          toLabel={t("pricing.effectiveTo")}
          toHint={t("pricing.effectiveToHint")}
          fromValue={globalFromStr}
          toValue={globalToStr}
          onFromChange={setGlobalFromStr}
          onToChange={setGlobalToStr}
          isRTL={isRTL}
        />
      </PricingFormModal>

      <PricingFormModal
        visible={kickboxModalOpen}
        title={kickboxFormTitle}
        onClose={() => cancelEditGlobal(true)}
        saveLabel={t("common.save")}
        onSave={() => void saveGlobalRule(true)}
        saving={kickboxSaving}
        loadingLabel={t("common.loading")}
        cancelLabel={t("common.cancel")}
        isRTL={isRTL}
      >
        <PricingTierFormFields
          capacityLabel={t("pricing.capacity")}
          priceLabel={t("pricing.price")}
          capValue={kickboxCapStr}
          priceValue={kickboxPriceStr}
          onCapChange={setKickboxCapStr}
          onPriceChange={setKickboxPriceStr}
          isRTL={isRTL}
        />
        <PricingRatePeriodFields
          fromLabel={t("pricing.effectiveFrom")}
          toLabel={t("pricing.effectiveTo")}
          toHint={t("pricing.effectiveToHint")}
          fromValue={kickboxFromStr}
          toValue={kickboxToStr}
          onFromChange={setKickboxFromStr}
          onToChange={setKickboxToStr}
          isRTL={isRTL}
        />
      </PricingFormModal>

      <PricingFormModal
        visible={athleteModalOpen}
        title={athleteFormTitle}
        onClose={cancelEditAthlete}
        saveLabel={t("common.save")}
        onSave={() => void saveAthleteRule()}
        saving={overrideSaving}
        loadingLabel={t("common.loading")}
        cancelLabel={t("common.cancel")}
        isRTL={isRTL}
      >
        <PricingPickerField
          label={t("pricing.pickAthlete")}
          value={pickedAthleteLabel}
          placeholder={t("pricing.chooseAthletePlaceholder")}
          onPress={() => {
            setPickerQ("");
            setPickerOpen(true);
          }}
          isRTL={isRTL}
          accessibilityLabel={t("pricing.pickAthlete")}
        />
        <PricingTierFormFields
          capacityLabel={t("pricing.capacity")}
          priceLabel={t("pricing.price")}
          capValue={athCapStr}
          priceValue={athPriceStr}
          onCapChange={setAthCapStr}
          onPriceChange={setAthPriceStr}
          isRTL={isRTL}
        />
        <PricingRatePeriodFields
          fromLabel={t("pricing.effectiveFrom")}
          toLabel={t("pricing.effectiveTo")}
          toHint={t("pricing.effectiveToHint")}
          fromValue={athFromStr}
          toValue={athToStr}
          onFromChange={setAthFromStr}
          onToChange={setAthToStr}
          isRTL={isRTL}
        />
      </PricingFormModal>

      <AppSearchSheet
        visible={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerQ("");
        }}
        title={t("pricing.pickAthlete")}
        dismissLabel={t("common.ok")}
        isRTL={isRTL}
        backdropAccessibilityLabel={t("common.cancel")}
        search={
          <AppSearchField
            value={pickerQ}
            onChangeText={setPickerQ}
            onSearch={(term) => void loadAthletes(term)}
            placeholder={t("pricing.searchAthletesPlaceholder")}
            isRTL={isRTL}
            loading={athletesLoading}
            accessibilityLabel={t("pricing.searchAthletesPlaceholder")}
          />
        }
        loading={athletesLoading}
        data={athletes}
        keyExtractor={(item) => (item.kind === "athlete" ? item.user_id : `quick:${item.id}`)}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
            onPress={() => selectAthletePick(item)}
            accessibilityRole="button"
            accessibilityLabel={item.full_name}
          >
            <Text style={[styles.pickerItemName, isRTL && ps.rtl]}>{item.full_name}</Text>
            <Text style={[styles.pickerItemRole, isRTL && ps.rtl]}>
              {item.kind === "athlete"
                ? `@${item.username}${item.phone ? ` · ${item.phone}` : ""}`
                : `${item.phone} · ${t("pricing.quickAddLabel")}${
                    item.linked_user_id ? "" : ` · ${t("pricing.quickAddNoAccount")}`
                  }`}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={[styles.pickerEmpty, isRTL && ps.rtl]}>{t("pricing.noAthletes")}</Text>}
      />
    </>
  );

  if (hideIntro) {
    return <View style={ps.embedded}>{body}</View>;
  }

  return (
    <ScrollView style={ps.screen} contentContainerStyle={ps.content} keyboardShouldPersistTaps="handled">
      <Text style={[ps.intro, isRTL && ps.rtl]}>{t("pricing.titleHint")}</Text>
      {body}
    </ScrollView>
  );
}

function resolveProfileName(r: OverrideRow): string {
  const raw = r.profiles;
  const p = raw ? (Array.isArray(raw) ? raw[0] : raw) : null;
  return p?.full_name?.trim() || "—";
}

function resolveOverrideName(r: OverrideRow): string {
  if (r.manual_participant_id) {
    const raw = r.manual_participants;
    const mp = raw ? (Array.isArray(raw) ? raw[0] : raw) : null;
    return mp?.full_name?.trim() || "—";
  }
  return resolveProfileName(r);
}

const styles = StyleSheet.create({
  pickerItem: {
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderMuted,
  },
  pickerItemName: { fontSize: 16, fontWeight: "700", color: theme.colors.text },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoft, textAlign: "center" },
});
