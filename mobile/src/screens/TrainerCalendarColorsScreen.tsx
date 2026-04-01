import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { TRAINER_COLOR_PRESETS, resolveTrainerAccentColor } from "../lib/trainerCalendarColor";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { useI18n } from "../context/I18nContext";

type Row = {
  user_id: string;
  full_name: string;
  username: string;
  role: string;
  calendar_color?: string | null;
};

export default function TrainerCalendarColorsScreen() {
  const { language, t, isRTL } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r1 = await supabase
      .from("profiles")
      .select("user_id, full_name, username, role, calendar_color")
      .in("role", ["coach", "manager"])
      .order("full_name");
    let data = r1.data;
    let error = r1.error;
    if (error && isMissingColumnError(error.message, "calendar_color")) {
      const r2 = await supabase
        .from("profiles")
        .select("user_id, full_name, username, role")
        .in("role", ["coach", "manager"])
        .order("full_name");
      data = r2.data as typeof r1.data;
      error = r2.error;
    }
    if (error) {
      setRows([]);
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
    } else {
      const list = ((data ?? []) as Row[]).map((r) => ({ ...r, calendar_color: r.calendar_color ?? null }));
      setRows(list);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveNow(userId: string, value: string | null) {
    setSavingId(userId);
    const { error } = await supabase.from("profiles").update({ calendar_color: value }).eq("user_id", userId);
    setSavingId(null);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    setRows((prev) => prev.map((r) => (r.user_id === userId ? { ...r, calendar_color: value } : r)));
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.muted, isRTL && styles.rtlText]}>{language === "he" ? "טוען מאמנים…" : "Loading trainers…"}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={[styles.header, isRTL && styles.rtlText]}>{t("menu.trainerColors")}</Text>
      <Text style={[styles.subhead, isRTL && styles.rtlText]}>
        {language === "he" ? "בחירה נשמרת אוטומטית." : "Changes save automatically."}
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.user_id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const preview = resolveTrainerAccentColor(item.calendar_color ?? null, item.user_id);
          const busy = savingId === item.user_id;
          return (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <View style={[styles.swatch, { backgroundColor: preview }]} />
                <View style={styles.cardHeadText}>
                  <Text style={styles.name}>{item.full_name}</Text>
                  <Text style={styles.meta}>
                    @{item.username} · {item.role}
                  </Text>
                </View>
                {busy ? <ActivityIndicator size="small" color={theme.colors.cta} /> : null}
              </View>
              <View style={[styles.pickerRow, isRTL && styles.pickerRowRtl]}>
                <Pressable
                  disabled={busy}
                  onPress={() => void saveNow(item.user_id, null)}
                  style={({ pressed }) => [
                    styles.autoBtn,
                    item.calendar_color == null && styles.autoBtnOn,
                    pressed && !busy && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.autoTxt, item.calendar_color == null && styles.autoTxtOn]}>
                    {language === "he" ? "אוטומטי" : "Auto"}
                  </Text>
                </Pressable>
                <View style={styles.presets}>
                  {TRAINER_COLOR_PRESETS.map((hex) => {
                    const selected = (item.calendar_color ?? "").toLowerCase() === hex.toLowerCase();
                    return (
                      <Pressable
                        key={hex}
                        disabled={busy}
                        onPress={() => void saveNow(item.user_id, hex)}
                        style={({ pressed }) => [
                          styles.presetDot,
                          { backgroundColor: hex },
                          selected && styles.presetDotOn,
                          pressed && !busy && { opacity: 0.9 },
                        ]}
                      />
                    );
                  })}
                </View>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={[styles.empty, isRTL && styles.rtlText]}>{language === "he" ? "לא נמצאו מאמנים או מנהלים." : "No coaches or managers found."}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing.xl },
  muted: { marginTop: 10, color: theme.colors.textMuted },
  rtlText: { textAlign: "right" },
  header: { padding: theme.spacing.md, paddingBottom: 2, fontSize: 18, fontWeight: "900", color: theme.colors.text },
  subhead: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm, fontSize: 13, color: theme.colors.textMuted },
  list: { padding: theme.spacing.md, paddingTop: 0, paddingBottom: theme.spacing.xl, gap: theme.spacing.md },
  card: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md, marginBottom: theme.spacing.sm },
  swatch: { width: 14, borderRadius: 4, alignSelf: "stretch", minHeight: 44 },
  cardHeadText: { flex: 1 },
  name: { fontSize: 17, fontWeight: "700", color: theme.colors.text },
  meta: { marginTop: 4, fontSize: 13, color: theme.colors.textMuted },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  pickerRowRtl: { flexDirection: "row-reverse" },
  autoBtn: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  autoBtnOn: { borderColor: theme.colors.cta, backgroundColor: theme.colors.cta, opacity: 0.95 },
  autoTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted },
  autoTxtOn: { color: theme.colors.ctaText },
  presets: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  presetDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: "rgba(0,0,0,0.08)" },
  presetDotOn: { borderColor: theme.colors.text, borderWidth: 2 },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl },
});
