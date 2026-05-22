import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
  TextInput,
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { PrimaryButton } from "../components/PrimaryButton";
import { PricingTierRow } from "../components/PricingTierRow";
import { CollapsiblePricingForm } from "../components/CollapsiblePricingForm";
import { PricingSection } from "../components/PricingSection";
import { PricingTierFormFields } from "../components/PricingTierFormFields";
import { PricingPickerField } from "../components/PricingPickerField";
import { AppSearchField } from "../components/AppSearchField";
import { pricingScreenStyles as ps } from "../components/pricingScreenStyles";
import type { AthleteSessionCapacityPricingRow, SessionCapacityPricingRow } from "../types/database";

type Props = { hideIntro?: boolean };

type AthletePick =
  | { kind: "athlete"; user_id: string; full_name: string; username: string; phone?: string | null }
  | { kind: "quick"; id: string; full_name: string; phone: string; linked_user_id: string | null };

type OverrideRow = AthleteSessionCapacityPricingRow & {
  profiles?: { full_name: string } | { full_name: string }[] | null;
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
  const { t, isRTL } = useI18n();
  const [capStr, setCapStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [rows, setRows] = useState<SessionCapacityPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [pickedAthleteId, setPickedAthleteId] = useState("");
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
  const [kickboxRows, setKickboxRows] = useState<SessionCapacityPricingRow[]>([]);
  const [kickboxSaving, setKickboxSaving] = useState(false);
  const [editGlobal, setEditGlobal] = useState<{ cap: number; isKickbox: boolean } | null>(null);
  const [editAthlete, setEditAthlete] = useState<{ userId: string; cap: number } | null>(null);
  const [globalFormOpen, setGlobalFormOpen] = useState(false);
  const [athleteFormOpen, setAthleteFormOpen] = useState(false);
  const [kickboxFormOpen, setKickboxFormOpen] = useState(false);

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
      .select("max_participants, price_ils, is_kickbox, updated_at")
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      notifyErr(error.message);
      setRows([]);
      setKickboxRows([]);
      return;
    }
    const list = (data as SessionCapacityPricingRow[]) ?? [];
    setRows(list.filter((r) => !r.is_kickbox));
    setKickboxRows(list.filter((r) => !!r.is_kickbox));
  }, [notifyErr]);

  const loadOverrides = useCallback(async () => {
    setOverrideLoading(true);
    const { data, error } = await supabase
      .from("athlete_session_capacity_pricing")
      .select("user_id, max_participants, price_ils, updated_at, profiles(full_name)")
      .order("max_participants", { ascending: true });
    setOverrideLoading(false);
    if (error) {
      notifyErr(error.message);
      setOverrideRows([]);
      return;
    }
    const list = (data as OverrideRow[]) ?? [];
    list.sort((a, b) => {
      const na = resolveProfileName(a).localeCompare(resolveProfileName(b));
      if (na !== 0) return na;
      return a.max_participants - b.max_participants;
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
      setPickedAthleteId(item.user_id);
      setPickedAthleteLabel(`${item.full_name} (@${item.username})`);
      setPickerOpen(false);
      return;
    }
    if (!item.linked_user_id) {
      notifyErr(t("pricing.quickAddRatesNeedAccount"));
      return;
    }
    setPickedAthleteId(item.linked_user_id);
    setPickedAthleteLabel(`${item.full_name} · ${item.phone}`);
    setPickerOpen(false);
  }

  async function saveGlobalRule(isKickbox: boolean) {
    const capRaw = isKickbox ? kickboxCapStr : capStr;
    const priceRaw = isKickbox ? kickboxPriceStr : priceStr;
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
    const editing = editGlobal?.isKickbox === isKickbox ? editGlobal : null;
    const setBusy = isKickbox ? setKickboxSaving : setSaving;
    setBusy(true);
    if (editing && editing.cap !== cap) {
      await supabase
        .from("session_capacity_pricing")
        .delete()
        .eq("max_participants", editing.cap)
        .eq("is_kickbox", isKickbox);
    }
    const { error } = await supabase.from("session_capacity_pricing").upsert(
      { max_participants: cap, price_ils: price, is_kickbox: isKickbox },
      { onConflict: "max_participants,is_kickbox" }
    );
    setBusy(false);
    if (error) {
      notifyErr(error.message);
      return;
    }
    if (isKickbox) {
      setKickboxCapStr("");
      setKickboxPriceStr("");
    } else {
      setCapStr("");
      setPriceStr("");
    }
    setEditGlobal(null);
    if (isKickbox) setKickboxFormOpen(false);
    else setGlobalFormOpen(false);
    await load();
  }

  function startEditGlobal(cap: number, price: number, isKickbox: boolean) {
    setEditGlobal({ cap, isKickbox });
    setAthleteFormOpen(false);
    if (isKickbox) {
      setKickboxFormOpen(true);
      setGlobalFormOpen(false);
    } else {
      setGlobalFormOpen(true);
      setKickboxFormOpen(false);
    }
    if (isKickbox) {
      setKickboxCapStr(String(cap));
      setKickboxPriceStr(String(price));
    } else {
      setCapStr(String(cap));
      setPriceStr(String(price));
    }
  }

  function cancelEditGlobal(isKickbox: boolean) {
    if (editGlobal?.isKickbox === isKickbox) setEditGlobal(null);
    if (isKickbox) {
      setKickboxCapStr("");
      setKickboxPriceStr("");
      setKickboxFormOpen(false);
    } else {
      setCapStr("");
      setPriceStr("");
      setGlobalFormOpen(false);
    }
  }

  async function saveAthleteRule() {
    if (!pickedAthleteId) {
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
    setOverrideSaving(true);
    if (editAthlete && (editAthlete.userId !== pickedAthleteId || editAthlete.cap !== cap)) {
      await supabase
        .from("athlete_session_capacity_pricing")
        .delete()
        .eq("user_id", editAthlete.userId)
        .eq("max_participants", editAthlete.cap);
    }
    const { error } = await supabase.from("athlete_session_capacity_pricing").upsert(
      { user_id: pickedAthleteId, max_participants: cap, price_ils: price },
      { onConflict: "user_id,max_participants" }
    );
    setOverrideSaving(false);
    if (error) {
      notifyErr(error.message);
      return;
    }
    setAthCapStr("");
    setAthPriceStr("");
    setPickedAthleteId("");
    setPickedAthleteLabel("");
    setEditAthlete(null);
    setAthleteFormOpen(false);
    await loadOverrides();
  }

  function startEditAthlete(row: OverrideRow) {
    const name = resolveProfileName(row);
    setGlobalFormOpen(false);
    setKickboxFormOpen(false);
    setAthleteFormOpen(true);
    setEditAthlete({ userId: row.user_id, cap: row.max_participants });
    setPickedAthleteId(row.user_id);
    setPickedAthleteLabel(name);
    setAthCapStr(String(row.max_participants));
    setAthPriceStr(String(row.price_ils));
  }

  function cancelEditAthlete() {
    setEditAthlete(null);
    setPickedAthleteId("");
    setPickedAthleteLabel("");
    setAthCapStr("");
    setAthPriceStr("");
    setAthleteFormOpen(false);
  }

  function confirmRemoveGlobal(cap: number, isKickbox: boolean) {
    const msg = t("pricing.confirmRemoveGlobalMessage");
    const run = async () => {
      await supabase.from("session_capacity_pricing").delete().eq("max_participants", cap).eq("is_kickbox", isKickbox);
      if (editGlobal?.cap === cap && editGlobal.isKickbox === isKickbox) cancelEditGlobal(isKickbox);
      await load();
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(msg)) return;
      void run();
      return;
    }
    Alert.alert(t("pricing.alertConfirmTitle"), msg, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("pricing.delete"),
        style: "destructive",
        onPress: () => void run(),
      },
    ]);
  }

  function confirmRemoveOverride(userId: string, cap: number, athleteLabelText: string) {
    const msg = t("pricing.removeAthleteRateConfirm").replace(/\{name\}/g, athleteLabelText);
    const run = async () => {
      await supabase
        .from("athlete_session_capacity_pricing")
        .delete()
        .eq("user_id", userId)
        .eq("max_participants", cap);
      if (editAthlete?.userId === userId && editAthlete.cap === cap) cancelEditAthlete();
      await loadOverrides();
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(msg)) return;
      void run();
      return;
    }
    Alert.alert(t("pricing.removeAthleteRateTitle"), msg, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("pricing.delete"),
        style: "destructive",
        onPress: () => void run(),
      },
    ]);
  }

  const tierSummary = useCallback(
    (n: number, ils: number) =>
      `${n} ${t("pricing.participantsLabel")} · ${ils} ₪`,
    [t]
  );

  const tierDraftSummary = useCallback(
    (capRaw: string, priceRaw: string) => {
      const parts: string[] = [];
      const cap = capRaw.trim();
      const price = priceRaw.trim();
      if (cap) parts.push(`${cap} ${t("pricing.participantsLabel")}`);
      if (price) parts.push(`${price} ₪`);
      return parts.length > 0 ? parts.join(" · ") : undefined;
    },
    [t]
  );

  const globalFormTitle =
    editGlobal && !editGlobal.isKickbox ? t("pricing.editRule") : t("pricing.addRule");
  const athleteFormTitle = editAthlete ? t("pricing.editRule") : t("pricing.addAthleteRate");
  const kickboxFormTitle = editGlobal?.isKickbox ? t("pricing.editRule") : t("pricing.addRule");

  const body = (
    <>
      <PricingSection
        title={t("pricing.standardSection")}
        hint={hideIntro ? undefined : t("pricing.titleHint")}
        isRTL={isRTL}
        loading={loading}
        emptyMessage={!loading && rows.length === 0 ? t("pricing.empty") : undefined}
        count={rows.length}
        footer={
          <CollapsiblePricingForm
            variant="inline"
            title={globalFormTitle}
            expanded={globalFormOpen}
            onToggle={() => setGlobalFormOpen((o) => !o)}
            summary={tierDraftSummary(capStr, priceStr)}
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
            <View style={ps.formActions}>
              <PrimaryButton
                label={t("common.save")}
                onPress={() => void saveGlobalRule(false)}
                loading={saving}
                loadingLabel={t("common.loading")}
              />
              {editGlobal && !editGlobal.isKickbox ? (
                <Pressable onPress={() => cancelEditGlobal(false)} style={ps.cancelEdit}>
                  <Text style={ps.cancelEditTxt}>{t("pricing.cancelEdit")}</Text>
                </Pressable>
              ) : null}
            </View>
          </CollapsiblePricingForm>
        }
      >
        {rows.map((r) => {
          const p = Number(r.price_ils);
          const label = `${r.max_participants} ${t("pricing.participantsLabel")}`;
          return (
            <PricingTierRow
              key={r.max_participants}
              title={label}
              priceLabel={`${p} ₪`}
              isRTL={isRTL}
              onEdit={() => startEditGlobal(r.max_participants, p, false)}
              onRemove={() => confirmRemoveGlobal(r.max_participants, false)}
            />
          );
        })}
      </PricingSection>

      <PricingSection
        title={t("pricing.specialAthleteSection")}
        hint={t("pricing.specialAthleteHint")}
        isRTL={isRTL}
        loading={overrideLoading}
        emptyMessage={!overrideLoading && overrideRows.length === 0 ? t("pricing.specialAthleteEmpty") : undefined}
        count={overrideRows.length}
        footer={
          <CollapsiblePricingForm
            variant="inline"
            title={athleteFormTitle}
            expanded={athleteFormOpen}
            onToggle={() => setAthleteFormOpen((o) => !o)}
            summary={
              pickedAthleteLabel
                ? tierDraftSummary(athCapStr, athPriceStr) ?? pickedAthleteLabel
                : tierDraftSummary(athCapStr, athPriceStr)
            }
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
            <View style={ps.formActions}>
              <PrimaryButton
                label={t("common.save")}
                onPress={() => void saveAthleteRule()}
                loading={overrideSaving}
                loadingLabel={t("common.loading")}
              />
              {editAthlete ? (
                <Pressable onPress={cancelEditAthlete} style={ps.cancelEdit}>
                  <Text style={ps.cancelEditTxt}>{t("pricing.cancelEdit")}</Text>
                </Pressable>
              ) : null}
            </View>
          </CollapsiblePricingForm>
        }
      >
        {overrideRows.map((r) => {
          const name = resolveProfileName(r);
          const p = Number(r.price_ils);
          const key = `${r.user_id}-${r.max_participants}`;
          const sub = tierSummary(r.max_participants, p);
          return (
            <PricingTierRow
              key={key}
              title={name}
              priceLabel={sub}
              isRTL={isRTL}
              onEdit={() => startEditAthlete(r)}
              onRemove={() => confirmRemoveOverride(r.user_id, r.max_participants, name)}
            />
          );
        })}
      </PricingSection>

      <PricingSection
        title={t("pricing.kickboxGlobalSection")}
        hint={t("pricing.kickboxGlobalHint")}
        isRTL={isRTL}
        loading={loading}
        emptyMessage={!loading && kickboxRows.length === 0 ? t("pricing.kickboxGlobalEmpty") : undefined}
        count={kickboxRows.length}
        footer={
          <CollapsiblePricingForm
            variant="inline"
            title={kickboxFormTitle}
            expanded={kickboxFormOpen}
            onToggle={() => setKickboxFormOpen((o) => !o)}
            summary={tierDraftSummary(kickboxCapStr, kickboxPriceStr)}
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
            <View style={ps.formActions}>
              <PrimaryButton
                label={t("common.save")}
                onPress={() => void saveGlobalRule(true)}
                loading={kickboxSaving}
                loadingLabel={t("common.loading")}
              />
              {editGlobal?.isKickbox ? (
                <Pressable onPress={() => cancelEditGlobal(true)} style={ps.cancelEdit}>
                  <Text style={ps.cancelEditTxt}>{t("pricing.cancelEdit")}</Text>
                </Pressable>
              ) : null}
            </View>
          </CollapsiblePricingForm>
        }
      >
        {kickboxRows.map((r) => {
          const p = Number(r.price_ils);
          const label = `${r.max_participants} ${t("pricing.participantsLabel")}`;
          return (
            <PricingTierRow
              key={`kick-${r.max_participants}`}
              title={label}
              priceLabel={`${p} ₪`}
              isRTL={isRTL}
              onEdit={() => startEditGlobal(r.max_participants, p, true)}
              onRemove={() => confirmRemoveGlobal(r.max_participants, true)}
            />
          );
        })}
      </PricingSection>

      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} accessibilityLabel={t("common.cancel")} />
          <View style={styles.modalBox}>
            <View style={[styles.modalHeader, isRTL && styles.modalHeaderRtl]}>
              <Text style={[styles.modalTitle, isRTL && ps.rtl]}>{t("pricing.pickAthlete")}</Text>
              <Pressable
                onPress={() => {
                  setPickerOpen(false);
                  setPickerQ("");
                }}
                accessibilityRole="button"
                accessibilityLabel={t("common.ok")}
              >
                <Text style={[styles.modalClose, isRTL && ps.rtl]}>{t("common.ok")}</Text>
              </Pressable>
            </View>
            <AppSearchField
              value={pickerQ}
              onChangeText={setPickerQ}
              onSearch={(term) => void loadAthletes(term)}
              placeholder={t("pricing.searchAthletesPlaceholder")}
              isRTL={isRTL}
              loading={athletesLoading}
              accessibilityLabel={t("pricing.searchAthletesPlaceholder")}
              style={styles.modalSearchField}
            />
            {athletesLoading ? (
              <ActivityIndicator size="large" color={theme.colors.cta} style={styles.modalLoader} accessibilityLabel={t("common.loading")} />
            ) : (
              <FlatList
                data={athletes}
                keyExtractor={(item) => (item.kind === "athlete" ? item.user_id : `quick:${item.id}`)}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
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
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && ps.rtl]}>{t("pricing.noAthletes")}</Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>
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

const styles = StyleSheet.create({
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  modalBox: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderMuted,
  },
  modalHeaderRtl: { flexDirection: "row-reverse" },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  modalClose: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "800" },
  modalLoader: { padding: theme.spacing.xl },
  modalSearchField: { marginHorizontal: theme.spacing.md, marginBottom: theme.spacing.sm },
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
