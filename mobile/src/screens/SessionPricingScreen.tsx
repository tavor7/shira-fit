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
import type { AthleteSessionCapacityPricingRow, SessionCapacityPricingRow } from "../types/database";

type Props = { hideIntro?: boolean };

type AthletePick = { user_id: string; full_name: string; username: string };

type OverrideRow = AthleteSessionCapacityPricingRow & {
  profiles?: { full_name: string } | { full_name: string }[] | null;
};

export default function SessionPricingScreen({ hideIntro = false }: Props) {
  const { language, t, isRTL } = useI18n();
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
  const [athletes, setAthletes] = useState<AthletePick[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("session_capacity_pricing")
      .select("max_participants, price_ils, updated_at")
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      setRows([]);
      return;
    }
    setRows((data as SessionCapacityPricingRow[]) ?? []);
  }, [t]);

  const loadOverrides = useCallback(async () => {
    setOverrideLoading(true);
    const { data, error } = await supabase
      .from("athlete_session_capacity_pricing")
      .select("user_id, max_participants, price_ils, updated_at, profiles(full_name)")
      .order("max_participants", { ascending: true });
    setOverrideLoading(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
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
  }, [t]);

  const loadAthletes = useCallback(async () => {
    setAthletesLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, username")
      .eq("role", "athlete")
      .order("full_name");
    setAthletes((data as AthletePick[]) ?? []);
    setAthletesLoading(false);
  }, []);

  useEffect(() => {
    void load();
    void loadOverrides();
  }, [load, loadOverrides]);

  useEffect(() => {
    if (pickerOpen) void loadAthletes();
  }, [pickerOpen, loadAthletes]);

  async function saveRule() {
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
    const { error } = await supabase.from("session_capacity_pricing").upsert(
      { max_participants: cap, price_ils: price },
      { onConflict: "max_participants" }
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

  async function saveAthleteRule() {
    if (!pickedAthleteId) {
      const msg = language === "he" ? "בחרו מתאמן קודם." : "Choose an athlete first.";
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(msg);
      else Alert.alert(t("common.error"), msg);
      return;
    }
    const cap = Number.parseInt(athCapStr.trim(), 10);
    if (!Number.isFinite(cap) || cap < 1) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("pricing.invalidCapacity"));
      else Alert.alert(t("common.error"), t("pricing.invalidCapacity"));
      return;
    }
    const price = Number.parseFloat(athPriceStr.replace(",", ".").trim());
    if (!Number.isFinite(price) || price < 0) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("pricing.invalidPrice"));
      else Alert.alert(t("common.error"), t("pricing.invalidPrice"));
      return;
    }
    setOverrideSaving(true);
    const { error } = await supabase.from("athlete_session_capacity_pricing").upsert(
      { user_id: pickedAthleteId, max_participants: cap, price_ils: price },
      { onConflict: "user_id,max_participants" }
    );
    setOverrideSaving(false);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    setAthCapStr("");
    setAthPriceStr("");
    await loadOverrides();
  }

  function confirmRemove(cap: number) {
    const msg = language === "he" ? "להסיר את המחיר לגודל הזה?" : "Remove pricing for this group size?";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(msg)) return;
      void (async () => {
        await supabase.from("session_capacity_pricing").delete().eq("max_participants", cap);
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
            await supabase.from("session_capacity_pricing").delete().eq("max_participants", cap);
            await load();
          })();
        },
      },
    ]);
  }

  function confirmRemoveOverride(userId: string, cap: number, athleteLabelText: string) {
    const msg = t("pricing.removeAthleteRateConfirm").replace("{name}", athleteLabelText);
    const run = async () => {
      await supabase.from("athlete_session_capacity_pricing").delete().eq("user_id", userId).eq("max_participants", cap);
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
        text: language === "he" ? "הסרה" : "Remove",
        style: "destructive",
        onPress: () => void run(),
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {!hideIntro ? <Text style={[styles.hint, isRTL && styles.rtl]}>{t("pricing.titleHint")}</Text> : null}

      <View style={styles.card}>
        <Text style={[styles.cardTitle, isRTL && styles.rtl]}>{t("pricing.addRule")}</Text>
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.capacity")}</Text>
        <TextInput
          value={capStr}
          onChangeText={setCapStr}
          keyboardType="number-pad"
          placeholder="8"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.price")}</Text>
        <TextInput
          value={priceStr}
          onChangeText={setPriceStr}
          keyboardType="decimal-pad"
          placeholder="120"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <PrimaryButton label={t("common.save")} onPress={() => void saveRule()} loading={saving} loadingLabel={t("common.loading")} />
      </View>

      <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{t("pricing.existing")}</Text>
      {loading ? (
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
                    {r.max_participants}{" "}
                    {language === "he" ? "משתתפים" : "participants"}
                  </Text>
                  <Text style={[styles.rowPrice, isRTL && styles.rtl]}>
                    {language === "he" ? `${p} ₪` : `${p} ₪`}
                  </Text>
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

      <Text style={[styles.sectionTitle, isRTL && styles.rtl, styles.sectionTitleSpaced]}>{t("pricing.specialAthleteSection")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>{t("pricing.specialAthleteHint")}</Text>

      <View style={styles.card}>
        <Text style={[styles.cardTitle, isRTL && styles.rtl]}>{t("pricing.addAthleteRate")}</Text>
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.pickAthlete")}</Text>
        <Pressable style={styles.pickerTouch} onPress={() => setPickerOpen(true)}>
          <Text style={pickedAthleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {pickedAthleteLabel || (language === "he" ? "בחרו מתאמן…" : "Choose athlete…")}
          </Text>
        </Pressable>
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.capacity")}</Text>
        <TextInput
          value={athCapStr}
          onChangeText={setAthCapStr}
          keyboardType="number-pad"
          placeholder="8"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.price")}</Text>
        <TextInput
          value={athPriceStr}
          onChangeText={setAthPriceStr}
          keyboardType="decimal-pad"
          placeholder="120"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
        />
        <PrimaryButton
          label={t("common.save")}
          onPress={() => void saveAthleteRule()}
          loading={overrideSaving}
          loadingLabel={t("common.loading")}
        />
      </View>

      <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{t("pricing.specialAthleteExisting")}</Text>
      {overrideLoading ? (
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} />
      ) : overrideRows.length === 0 ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{t("pricing.specialAthleteEmpty")}</Text>
      ) : (
        <View style={styles.list}>
          {overrideRows.map((r) => {
            const name = resolveProfileName(r);
            const p = Number(r.price_ils);
            const key = `${r.user_id}-${r.max_participants}`;
            return (
              <View key={key} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowCap, isRTL && styles.rtl]} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={[styles.overrideSub, isRTL && styles.rtl]}>
                    {language === "he"
                      ? `${r.max_participants} משתתפים · ${p} ₪`
                      : `${r.max_participants} participants · ${p} ₪`}
                  </Text>
                </View>
                <Pressable
                  onPress={() => confirmRemoveOverride(r.user_id, r.max_participants, name)}
                  style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.removeTxt}>{t("pricing.delete")}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <Modal visible={pickerOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} />
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, isRTL && styles.rtl]}>{t("pricing.pickAthlete")}</Text>
              <Pressable onPress={() => setPickerOpen(false)}>
                <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
              </Pressable>
            </View>
            {athletesLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={athletes}
                keyExtractor={(item) => item.user_id}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                    onPress={() => {
                      setPickedAthleteId(item.user_id);
                      setPickedAthleteLabel(`${item.full_name} (@${item.username})`);
                      setPickerOpen(false);
                    }}
                  >
                    <Text style={styles.pickerItemName}>{item.full_name}</Text>
                    <Text style={styles.pickerItemRole}>@{item.username}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && styles.rtl]}>
                    {language === "he" ? "אין מתאמנים" : "No athletes"}
                  </Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function resolveProfileName(r: OverrideRow): string {
  const raw = r.profiles;
  const p = raw ? (Array.isArray(raw) ? raw[0] : raw) : null;
  return p?.full_name?.trim() || "—";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  hint: { color: theme.colors.textMuted, lineHeight: 20, marginBottom: theme.spacing.md },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  cardTitle: { fontWeight: "900", fontSize: 15, color: theme.colors.text, marginBottom: 4 },
  label: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, marginTop: 4 },
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
  sectionTitleSpaced: { marginTop: theme.spacing.xl },
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
  overrideSub: { marginTop: 4, fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  removeBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  removeTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 13 },
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
});
