import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { supabase } from "../lib/supabase";
import { resolveTrainerAccentColor } from "../lib/trainerCalendarColor";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppSearchField } from "./AppSearchField";
import { AppSearchSheet } from "./AppSearchSheet";

export type CoachPickOption = {
  user_id: string;
  full_name: string;
  username: string;
  role: string;
  calendar_color?: string | null;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (coach: CoachPickOption) => void;
  selectedCoachId?: string;
};

export function CoachPickerSheet({ visible, onClose, onSelect, selectedCoachId }: Props) {
  const { t, isRTL } = useI18n();
  const [query, setQuery] = useState("");
  const [coaches, setCoaches] = useState<CoachPickOption[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCoaches = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, username, role, calendar_color")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setCoaches((data as CoachPickOption[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      return;
    }
    void loadCoaches();
  }, [visible, loadCoaches]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return coaches;
    return coaches.filter(
      (c) =>
        (c.full_name ?? "").toLowerCase().includes(q) ||
        (c.username ?? "").toLowerCase().includes(q) ||
        (c.role ?? "").toLowerCase().includes(q)
    );
  }, [coaches, query]);

  function pick(coach: CoachPickOption) {
    onSelect(coach);
    onClose();
  }

  return (
    <AppSearchSheet
      visible={visible}
      onClose={onClose}
      title={t("sessionForm.allTrainers")}
      dismissLabel={t("common.ok")}
      isRTL={isRTL}
      backdropAccessibilityLabel={t("common.cancel")}
      sheetHeightPct={0.78}
      search={
        <AppSearchField
          value={query}
          onChangeText={setQuery}
          onSearch={() => {}}
          placeholder={t("coachPricing.searchCoachesPlaceholder")}
          isRTL={isRTL}
          accessibilityLabel={t("coachPricing.searchCoachesPlaceholder")}
        />
      }
      loading={loading}
      data={filtered}
      keyExtractor={(item) => item.user_id}
      renderItem={({ item }) => {
        const selected = item.user_id === selectedCoachId;
        const accent = resolveTrainerAccentColor(item.calendar_color, item.user_id);
        return (
          <Pressable
            style={({ pressed }) => [
              styles.row,
              isRTL && styles.rowRtl,
              selected && styles.rowSelected,
              pressed && { opacity: 0.88 },
            ]}
            onPress={() => pick(item)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={item.full_name}
          >
            <View style={[styles.rowLeading, isRTL && styles.rowLeadingRtl]}>
              <View style={[styles.colorDot, { backgroundColor: accent }]} />
              <View style={styles.rowTextCol}>
                <Text style={[styles.rowName, isRTL && styles.rtlText]} numberOfLines={1}>
                  {item.full_name}
                </Text>
                <Text style={[styles.rowMeta, isRTL && styles.rtlText]} numberOfLines={1}>
                  @{item.username}
                </Text>
              </View>
            </View>
            <View style={[styles.rolePill, item.role === "manager" && styles.rolePillManager]}>
              <Text style={styles.rolePillTxt}>{formatRoleLabel(item.role, t)}</Text>
            </View>
            {selected ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        );
      }}
      ListEmptyComponent={
        <Text style={[styles.empty, isRTL && styles.rtlText]}>{t("sessionForm.noTrainers")}</Text>
      }
    />
  );
}

function formatRoleLabel(role: string, t: (key: string) => string): string {
  if (role === "manager") return t("coachPricing.roleManager");
  if (role === "coach") return t("coachPricing.roleCoach");
  return role;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowSelected: {
    backgroundColor: theme.colors.surfaceElevated,
  },
  rowLeading: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minWidth: 0 },
  rowLeadingRtl: { flexDirection: "row-reverse" },
  colorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  rowTextCol: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  rowMeta: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  rolePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rolePillManager: {
    borderColor: theme.colors.cta,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  rolePillTxt: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  check: {
    fontSize: 16,
    fontWeight: "900",
    color: theme.colors.cta,
    marginStart: 2,
  },
  empty: {
    padding: theme.spacing.lg,
    textAlign: "center",
    color: theme.colors.textSoft,
    fontWeight: "600",
  },
  rtlText: { textAlign: "right" },
});
