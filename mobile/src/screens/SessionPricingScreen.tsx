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
  const [athletes, setAthletes] = useState<AthletePick[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);

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
      .select("max_participants, price_ils, updated_at")
      .order("max_participants", { ascending: true });
    setLoading(false);
    if (error) {
      notifyErr(error.message);
      setRows([]);
      return;
    }
    setRows((data as SessionCapacityPricingRow[]) ?? []);
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
    const cap = parseTierCapacity(capStr);
    if (cap === null) {
      notifyErr(t("pricing.invalidCapacity"));
      return;
    }
    const price = parseMoneyInput(priceStr);
    if (price === null) {
      notifyErr(t("pricing.invalidPrice"));
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("session_capacity_pricing").upsert(
      { max_participants: cap, price_ils: price },
      { onConflict: "max_participants" }
    );
    setSaving(false);
    if (error) {
      notifyErr(error.message);
      return;
    }
    setCapStr("");
    setPriceStr("");
    await load();
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
    await loadOverrides();
  }

  function confirmRemove(cap: number) {
    const msg = t("pricing.confirmRemoveGlobalMessage");
    const run = async () => {
      await supabase.from("session_capacity_pricing").delete().eq("max_participants", cap);
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
          accessibilityLabel={t("pricing.capacity")}
        />
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.price")}</Text>
        <TextInput
          value={priceStr}
          onChangeText={setPriceStr}
          keyboardType="decimal-pad"
          placeholder="120"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
          accessibilityLabel={t("pricing.price")}
        />
        <PrimaryButton label={t("common.save")} onPress={() => void saveRule()} loading={saving} loadingLabel={t("common.loading")} />
      </View>

      <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{t("pricing.existing")}</Text>
      {loading ? (
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} accessibilityLabel={t("common.loading")} />
      ) : rows.length === 0 ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{t("pricing.empty")}</Text>
      ) : (
        <View style={styles.list}>
          {rows.map((r) => {
            const p = Number(r.price_ils);
            const label = `${r.max_participants} ${t("pricing.participantsLabel")}`;
            return (
              <View key={r.max_participants} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowCap, isRTL && styles.rtl]}>{label}</Text>
                  <Text style={[styles.rowPrice, isRTL && styles.rtl]}>{`${p} ₪`}</Text>
                </View>
                <Pressable
                  onPress={() => confirmRemove(r.max_participants)}
                  style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.85 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("pricing.delete")}: ${label}`}
                >
                  <Text style={styles.removeTxt}>{t("pricing.delete")}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <Text style={[styles.sectionTitle, isRTL && styles.rtl, styles.sectionTitleSpaced]}>{t("pricing.specialAthleteSection")}</Text>
      <Text style={[styles.hint, styles.hintAfterTitle, isRTL && styles.rtl]}>{t("pricing.specialAthleteHint")}</Text>

      <View style={styles.card}>
        <Text style={[styles.cardTitle, isRTL && styles.rtl]}>{t("pricing.addAthleteRate")}</Text>
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.pickAthlete")}</Text>
        <Pressable
          style={styles.pickerTouch}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t("pricing.pickAthlete")}
        >
          <Text style={pickedAthleteLabel ? styles.pickerText : styles.pickerPlaceholder} numberOfLines={2}>
            {pickedAthleteLabel || t("pricing.chooseAthletePlaceholder")}
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
          accessibilityLabel={t("pricing.capacity")}
        />
        <Text style={[styles.label, isRTL && styles.rtl]}>{t("pricing.price")}</Text>
        <TextInput
          value={athPriceStr}
          onChangeText={setAthPriceStr}
          keyboardType="decimal-pad"
          placeholder="120"
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.input}
          accessibilityLabel={t("pricing.price")}
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
        <ActivityIndicator color={theme.colors.cta} style={styles.loader} accessibilityLabel={t("common.loading")} />
      ) : overrideRows.length === 0 ? (
        <Text style={[styles.empty, isRTL && styles.rtl]}>{t("pricing.specialAthleteEmpty")}</Text>
      ) : (
        <View style={styles.list}>
          {overrideRows.map((r) => {
            const name = resolveProfileName(r);
            const p = Number(r.price_ils);
            const key = `${r.user_id}-${r.max_participants}`;
            const sub = tierSummary(r.max_participants, p);
            return (
              <View key={key} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowCap, isRTL && styles.rtl]} numberOfLines={2}>
                    {name}
                  </Text>
                  <Text style={[styles.overrideSub, isRTL && styles.rtl]} numberOfLines={2}>
                    {sub}
                  </Text>
                </View>
                <Pressable
                  onPress={() => confirmRemoveOverride(r.user_id, r.max_participants, name)}
                  style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.85 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("pricing.delete")}: ${name}, ${sub}`}
                >
                  <Text style={styles.removeTxt}>{t("pricing.delete")}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setPickerOpen(false)} accessibilityLabel={t("common.cancel")} />
          <View style={styles.modalBox}>
            <View style={[styles.modalHeader, isRTL && styles.modalHeaderRtl]}>
              <Text style={[styles.modalTitle, isRTL && styles.rtl]}>{t("pricing.pickAthlete")}</Text>
              <Pressable onPress={() => setPickerOpen(false)} accessibilityRole="button" accessibilityLabel={t("common.ok")}>
                <Text style={[styles.modalClose, isRTL && styles.rtl]}>{t("common.ok")}</Text>
              </Pressable>
            </View>
            {athletesLoading ? (
              <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} accessibilityLabel={t("common.loading")} />
            ) : (
              <FlatList
                data={athletes}
                keyExtractor={(item) => item.user_id}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                    onPress={() => {
                      setPickedAthleteId(item.user_id);
                      setPickedAthleteLabel(`${item.full_name} (@${item.username})`);
                      setPickerOpen(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.full_name}, @${item.username}`}
                  >
                    <Text style={[styles.pickerItemName, isRTL && styles.rtl]}>{item.full_name}</Text>
                    <Text style={[styles.pickerItemRole, isRTL && styles.rtl]}>@{item.username}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={[styles.pickerEmpty, isRTL && styles.rtl]}>{t("pricing.noAthletes")}</Text>
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
  hintAfterTitle: { marginTop: -4 },
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
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
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
