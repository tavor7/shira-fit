import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Pressable,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { PrimaryButton } from "../components/PrimaryButton";
import type { CoachCapacityPricingRow } from "../types/database";

type Trainer = { user_id: string; full_name: string; username: string; role: string };

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

  const coachId = lockedCoachId ?? pickedCoachId;

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
    await load();
  }

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
            await load();
          })();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {allowCoachPicker && !lockedCoachId ? (
        <>
          <Text style={[styles.label, isRTL && styles.rtl]}>{language === "he" ? "מאמן" : "Coach"}</Text>
          <Pressable style={styles.pickerTouch} onPress={() => setPickerOpen(true)}>
            <Text style={coachLabel ? styles.pickerText : styles.pickerPlaceholder}>
              {coachLabel || (language === "he" ? "בחרו מאמן או מנהל…" : "Choose coach or manager…")}
            </Text>
          </Pressable>
          <Modal visible={pickerOpen} transparent animationType="slide">
            <View style={styles.modalBackdrop}>
              <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
              <View style={styles.modalBox}>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, isRTL && styles.rtl]}>{language === "he" ? "מאמנים" : "Trainers"}</Text>
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
                      <Text style={[styles.pickerEmpty, isRTL && styles.rtl]}>
                        {language === "he" ? "אין מאמנים" : "No trainers"}
                      </Text>
                    }
                  />
                )}
              </View>
            </View>
          </Modal>
        </>
      ) : null}

      {!hideIntro ? <Text style={[styles.hint, isRTL && styles.rtl]}>{t("coachPricing.titleHint")}</Text> : null}

      <View style={[styles.card, !coachId && { opacity: 0.55 }]}>
        <Text style={[styles.cardTitle, isRTL && styles.rtl]}>{t("pricing.addRule")}</Text>
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("coachPricing.tierFieldLabel")}</Text>
        <TextInput
          value={capStr}
          onChangeText={setCapStr}
          keyboardType="number-pad"
          placeholder="8"
          editable={!!coachId}
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("coachPricing.sessionPayout")}</Text>
        <TextInput
          value={priceStr}
          onChangeText={setPriceStr}
          keyboardType="decimal-pad"
          placeholder="40"
          editable={!!coachId}
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <PrimaryButton
          label={t("common.save")}
          onPress={() => void saveRule()}
          loading={saving}
          loadingLabel={t("common.loading")}
          disabled={!coachId}
        />
      </View>

      <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{t("pricing.existing")}</Text>
      {!coachId ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{language === "he" ? "בחרו מאמן כדי לערוך תעריפים." : "Pick a coach to edit rates."}</Text>
      ) : loading ? (
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} />
      ) : rows.length === 0 ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{t("pricing.empty")}</Text>
      ) : (
        <View style={styles.list}>
          {rows.map((r) => {
            const p = Number(r.price_ils);
            return (
              <View key={r.max_participants} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowCap, isRTL && styles.rtl]}>
                    {t("coachPricing.tierListCaption").replace("{n}", String(r.max_participants))}
                  </Text>
                  <Text style={[styles.rowPrice, isRTL && styles.rtl]}>{`${p} ₪`}</Text>
                </View>
                <Pressable
                  onPress={() => confirmRemove(r.max_participants)}
                  style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.removeTxt}>{t("pricing.delete")}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  hint: { color: theme.colors.textMuted, lineHeight: 20, marginBottom: theme.spacing.md },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    backgroundColor: theme.colors.white,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerText: { fontSize: 16, color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, color: theme.colors.textSoftOnLight },
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
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  cardTitle: { fontWeight: "900", fontSize: 15, color: theme.colors.text, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  sectionTitle: { marginTop: theme.spacing.lg, fontWeight: "900", fontSize: 16, color: theme.colors.text },
  loader: { marginTop: theme.spacing.md },
  empty: { marginTop: theme.spacing.sm, color: theme.colors.textSoft },
  list: { marginTop: theme.spacing.sm, gap: theme.spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 12,
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowCap: { fontWeight: "800", fontSize: 15, color: theme.colors.text },
  rowPrice: { marginTop: 4, fontSize: 14, fontWeight: "700", color: theme.colors.cta },
  removeBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  removeTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 13 },
});
