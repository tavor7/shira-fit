import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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
  findNodeHandle,
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
import { pricingScreenStyles as ps } from "../components/pricingScreenStyles";
import type { CoachCapacityPricingRow } from "../types/database";

type Trainer = { user_id: string; full_name: string; username: string; role: string };

type Props = {
  /** Manager: show coach picker. Ignored when lockedCoachId is set. */
  allowCoachPicker?: boolean;
  /** Coach (or manager editing self): fixed coach user id. */
  lockedCoachId?: string | null;
  hideIntro?: boolean;
  /** Parent hub scroll — scrolls the add/edit form into view when editing a tier. */
  parentScrollRef?: RefObject<ScrollView | null>;
};

export default function CoachCapacityPricingScreen({
  allowCoachPicker = false,
  lockedCoachId = null,
  hideIntro = false,
  parentScrollRef,
}: Props) {
  const { language, t, isRTL } = useI18n();
  const [pickedCoachId, setPickedCoachId] = useState("");
  const [coachLabel, setCoachLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [trainersLoading, setTrainersLoading] = useState(false);
  const [capStr, setCapStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [rows, setRows] = useState<CoachCapacityPricingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editCap, setEditCap] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const formFooterRef = useRef<View>(null);

  const coachId = lockedCoachId ?? pickedCoachId;

  const scrollFormIntoView = useCallback(() => {
    const anchor = formFooterRef.current;
    if (!anchor) return;
    if (Platform.OS === "web") {
      const el = anchor as unknown as { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void };
      el.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      return;
    }
    const scroll = parentScrollRef?.current;
    if (!scroll) return;
    const scrollNode = findNodeHandle(scroll);
    if (!scrollNode) return;
    anchor.measureLayout(
      scrollNode,
      (_x, y) => scroll.scrollTo({ y: Math.max(0, y - 16), animated: true }),
      () => {}
    );
  }, [parentScrollRef]);

  const loadTrainers = useCallback(async () => {
    setTrainersLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, username, role")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setTrainers((data as Trainer[]) ?? []);
    setTrainersLoading(false);
  }, []);

  const load = useCallback(async () => {
    if (!coachId) {
      setRows([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("coach_capacity_pricing")
      .select("coach_id, max_participants, price_ils, updated_at")
      .eq("coach_id", coachId)
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      setRows([]);
      return;
    }
    setRows((data as CoachCapacityPricingRow[]) ?? []);
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
    setEditCap(null);
    setCapStr("");
    setPriceStr("");
    setFormOpen(false);
  }, [coachId]);

  useEffect(() => {
    if (allowCoachPicker && pickerOpen) void loadTrainers();
  }, [allowCoachPicker, pickerOpen, loadTrainers]);

  async function saveRule() {
    if (!coachId) {
      showPickCoach();
      return;
    }
    const cap = Number.parseInt(capStr.trim(), 10);
    if (!Number.isFinite(cap) || cap < 1) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("pricing.invalidCapacity"));
      else Alert.alert(t("common.error"), t("pricing.invalidCapacity"));
      return;
    }
    const price = Number.parseFloat(priceStr.replace(",", ".").trim());
    if (!Number.isFinite(price) || price < 0) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("pricing.invalidPrice"));
      else Alert.alert(t("common.error"), t("pricing.invalidPrice"));
      return;
    }
    setSaving(true);
    if (editCap !== null && editCap !== cap) {
      const { error: delErr } = await supabase
        .from("coach_capacity_pricing")
        .delete()
        .eq("coach_id", coachId)
        .eq("max_participants", editCap);
      if (delErr) {
        setSaving(false);
        if (Platform.OS === "web" && typeof window !== "undefined") window.alert(delErr.message);
        else Alert.alert(t("common.error"), delErr.message);
        return;
      }
    }
    const { error } = await supabase.from("coach_capacity_pricing").upsert(
      { coach_id: coachId, max_participants: cap, price_ils: price },
      { onConflict: "coach_id,max_participants" }
    );
    setSaving(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    setCapStr("");
    setPriceStr("");
    setEditCap(null);
    setFormOpen(false);
    await load();
  }

  function startEdit(cap: number, price: number) {
    setEditCap(cap);
    setCapStr(String(cap));
    setPriceStr(String(price));
    setFormOpen(true);
    requestAnimationFrame(() => scrollFormIntoView());
  }

  function toggleForm() {
    if (!coachId) {
      showPickCoach();
      return;
    }
    if (formOpen) {
      if (editCap !== null) cancelEdit();
      else setFormOpen(false);
    } else {
      setFormOpen(true);
    }
  }

  function cancelEdit() {
    setEditCap(null);
    setCapStr("");
    setPriceStr("");
    setFormOpen(false);
  }

  const formTitle = editCap !== null ? t("pricing.editRule") : t("pricing.addRule");
  const formSummary = (() => {
    const parts: string[] = [];
    const cap = capStr.trim();
    const price = priceStr.trim();
    if (cap) parts.push(`${cap} ${t("pricing.participantsLabel")}`);
    if (price) parts.push(`${price} ₪`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  })();

  function showPickCoach() {
    const msg = language === "he" ? "בחרו מאמן קודם." : "Choose a coach first.";
    if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
    else Alert.alert(t("common.error"), msg);
  }

  function confirmRemove(cap: number) {
    if (!coachId) {
      showPickCoach();
      return;
    }
    const msg = language === "he" ? "להסיר את התעריף לגודל הזה?" : "Remove this rate?";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(msg)) return;
      void (async () => {
        await supabase.from("coach_capacity_pricing").delete().eq("coach_id", coachId).eq("max_participants", cap);
        if (editCap === cap) cancelEdit();
        await load();
      })();
      return;
    }
    Alert.alert(language === "he" ? "אישור" : "Confirm", msg, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: language === "he" ? "הסרה" : "Remove",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await supabase.from("coach_capacity_pricing").delete().eq("coach_id", coachId).eq("max_participants", cap);
            if (editCap === cap) cancelEdit();
            await load();
          })();
        },
      },
    ]);
  }

  const pickCoachLabel = language === "he" ? "מאמן" : "Coach";
  const pickCoachPlaceholder = language === "he" ? "בחרו מאמן או מנהל…" : "Choose coach or manager…";

  const body = (
    <>
      {allowCoachPicker && !lockedCoachId ? (
        <View style={styles.coachPickCard}>
          <PricingPickerField
            label={pickCoachLabel}
            value={coachLabel}
            placeholder={pickCoachPlaceholder}
            onPress={() => setPickerOpen(true)}
            isRTL={isRTL}
            accessibilityLabel={pickCoachLabel}
          />
        </View>
      ) : null}

      <View style={!coachId ? styles.disabledWrap : undefined}>
        <PricingSection
          title={t("coachPricing.ratesSection")}
          hint={hideIntro ? t("coachPricing.titleHint") : undefined}
          isRTL={isRTL}
          loading={!!coachId && loading}
          emptyMessage={
            !coachId
              ? language === "he"
                ? "בחרו מאמן כדי לערוך תעריפים."
                : "Pick a coach to edit rates."
              : !loading && rows.length === 0
                ? t("pricing.empty")
                : undefined
          }
          count={coachId ? rows.length : undefined}
          footer={
            <View ref={formFooterRef} collapsable={false}>
              <CollapsiblePricingForm
                variant="inline"
                title={formTitle}
                expanded={formOpen}
                onToggle={toggleForm}
                summary={formSummary}
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
              <View style={ps.formActions}>
                <PrimaryButton
                  label={t("common.save")}
                  onPress={() => void saveRule()}
                  loading={saving}
                  loadingLabel={t("common.loading")}
                  disabled={!coachId}
                />
                {editCap !== null ? (
                  <Pressable onPress={cancelEdit} style={ps.cancelEdit}>
                    <Text style={ps.cancelEditTxt}>{t("pricing.cancelEdit")}</Text>
                  </Pressable>
                ) : null}
              </View>
              </CollapsiblePricingForm>
            </View>
          }
        >
          {rows.map((r) => {
            const p = Number(r.price_ils);
            const title = t("coachPricing.tierListCaption").replace("{n}", String(r.max_participants));
            return (
              <PricingTierRow
                key={r.max_participants}
                title={title}
                priceLabel={`${p} ₪`}
                isRTL={isRTL}
                onEdit={() => startEdit(r.max_participants, p)}
                onRemove={() => confirmRemove(r.max_participants)}
              />
            );
          })}
        </PricingSection>
      </View>

      <Modal visible={pickerOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
          <View style={styles.modalBox}>
            <View style={[styles.modalHeader, isRTL && styles.modalHeaderRtl]}>
              <Text style={[styles.modalTitle, isRTL && ps.rtl]}>{language === "he" ? "מאמנים" : "Trainers"}</Text>
              <Pressable onPress={() => setPickerOpen(false)}>
                <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
              </Pressable>
            </View>
            {trainersLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={trainers}
                keyExtractor={(item) => item.user_id}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                    onPress={() => {
                      setPickedCoachId(item.user_id);
                      setCoachLabel(`${item.full_name} (@${item.username})`);
                      cancelEdit();
                      setPickerOpen(false);
                    }}
                  >
                    <Text style={styles.pickerItemName}>{item.full_name}</Text>
                    <Text style={styles.pickerItemRole}>
                      @{item.username} · {item.role}
                    </Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && ps.rtl]}>
                    {language === "he" ? "אין מאמנים" : "No trainers"}
                  </Text>
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
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: {
    backgroundColor: theme.colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: theme.spacing.md,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  modalHeaderRtl: { flexDirection: "row-reverse" },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
});
