import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { theme } from "../theme";
import { supabase } from "../lib/supabase";
import { TRAINER_COLOR_PRESETS, normalizeHexInput, resolveTrainerAccentColor } from "../lib/trainerCalendarColor";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { PrimaryButton } from "../components/PrimaryButton";
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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
      const d: Record<string, string> = {};
      for (const r of list) {
        d[r.user_id] = r.calendar_color?.trim() ?? "";
      }
      setDrafts(d);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(userId: string) {
    const raw = drafts[userId]?.trim() ?? "";
    let value: string | null = null;
    if (raw.length > 0) {
      const norm = normalizeHexInput(raw.startsWith("#") ? raw : `#${raw}`);
      if (!norm) {
        Alert.alert(
          language === "he" ? "צבע לא תקין" : "Invalid color",
          language === "he" ? "השתמשו בצבע הקס כמו ‎#5B9BD5‎ (6 ספרות אחרי #)." : "Use a hex color like #5B9BD5 (six digits after #)."
        );
        return;
      }
      value = norm;
    }
    setSavingId(userId);
    const { error } = await supabase.from("profiles").update({ calendar_color: value }).eq("user_id", userId);
    setSavingId(null);
    if (error) {
      if (Platform.OS === "web" && typeof window !== "undefined") window.alert(error.message);
      else Alert.alert(t("common.error"), error.message);
      return;
    }
    setRows((prev) => prev.map((r) => (r.user_id === userId ? { ...r, calendar_color: value } : r)));
    setDrafts((prev) => ({ ...prev, [userId]: value ?? "" }));
  }

  function applyPreset(userId: string, hex: string) {
    setDrafts((prev) => ({ ...prev, [userId]: hex }));
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
      <Text style={[styles.intro, isRTL && styles.rtlText]}>
        {language === "he"
          ? "לכל מאמן יש פס צבע בכרטיסי האימונים. השאירו ריק כדי להשתמש בצבע אוטומטי. רק מנהלים יכולים לשנות."
          : "Each trainer gets a color stripe on session cards. Leave the field empty to use an automatic color. Only managers can change these."}
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.user_id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const draftRaw = drafts[item.user_id]?.trim() ?? "";
          let effectiveStored: string | null | undefined = item.calendar_color;
          if (draftRaw.length > 0) {
            const n = normalizeHexInput(draftRaw.startsWith("#") ? draftRaw : `#${draftRaw}`);
            effectiveStored = n ?? item.calendar_color;
          } else if (draftRaw === "" && drafts[item.user_id] !== undefined) {
            effectiveStored = null;
          }
          const preview = resolveTrainerAccentColor(effectiveStored, item.user_id);
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
              </View>
              <Text style={[styles.label, isRTL && styles.rtlText]}>Hex (#RRGGBB)</Text>
              <TextInput
                style={styles.input}
                value={drafts[item.user_id] ?? ""}
                onChangeText={(t) => setDrafts((p) => ({ ...p, [item.user_id]: t }))}
                placeholder={language === "he" ? "#5B9BD5 או ריק" : "#5B9BD5 or empty"}
                placeholderTextColor={theme.colors.placeholderOnLight}
                autoCapitalize="characters"
              />
              <Text style={[styles.presetsLabel, isRTL && styles.rtlText]}>{language === "he" ? "בחירות מהירות" : "Presets"}</Text>
              <View style={styles.presets}>
                {TRAINER_COLOR_PRESETS.map((hex) => (
                  <Pressable
                    key={hex}
                    onPress={() => applyPreset(item.user_id, hex)}
                    style={({ pressed }) => [
                      styles.presetDot,
                      { backgroundColor: hex },
                      pressed && { opacity: 0.85 },
                    ]}
                  />
                ))}
              </View>
              <PrimaryButton
                label={language === "he" ? "שמירת צבע" : "Save color"}
                onPress={() => save(item.user_id)}
                loading={busy}
                loadingLabel={t("common.loading")}
              />
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
  intro: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
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
  label: { marginTop: theme.spacing.sm, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  presetsLabel: { marginTop: theme.spacing.md, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10, marginBottom: theme.spacing.md },
  presetDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl },
});
