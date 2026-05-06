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
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { PrimaryButton } from "../components/PrimaryButton";
import type { SessionCapacityPricingRow } from "../types/database";

type Props = { hideIntro?: boolean };

export default function SessionPricingScreen({ hideIntro = false }: Props) {
  const { language, t, isRTL } = useI18n();
  const [capStr, setCapStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [rows, setRows] = useState<SessionCapacityPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    void load();
  }, [load]);

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
    </ScrollView>
  );
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
