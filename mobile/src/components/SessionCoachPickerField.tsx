import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { useI18n } from "../context/I18nContext";

export type CoachOption = {
  user_id: string;
  full_name: string;
  role: string;
  username: string;
  calendar_color?: string | null;
};

export function formatCoachOptionLabel(opt: CoachOption): string {
  return `${opt.full_name} — ${opt.role}`;
}

type Props = {
  coachId: string;
  coachLabel: string;
  onSelect: (opt: CoachOption) => void;
  disabled?: boolean;
  /** Section label above the field; defaults to Trainer. */
  label?: string;
};

export function SessionCoachPickerField({ coachId, coachLabel, onSelect, disabled, label }: Props) {
  const { language, t, isRTL } = useI18n();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CoachOption[]>([]);
  const [loading, setLoading] = useState(false);

  const fieldLabel = label ?? (language === "he" ? "מאמן" : "Trainer");

  const loadCoaches = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, role, username, calendar_color")
      .in("role", ["coach", "manager"])
      .order("full_name");
    setOptions((data as CoachOption[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadCoaches();
  }, [open, loadCoaches]);

  function pick(opt: CoachOption) {
    onSelect(opt);
    setOpen(false);
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.sectionLabel, isRTL && styles.rtlText]}>{fieldLabel}</Text>
      <Pressable
        style={({ pressed }) => [sf.control, pressed && !disabled && { opacity: 0.9 }, disabled && { opacity: 0.5 }]}
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
      >
        <Text style={coachLabel ? sf.controlText : sf.controlPlaceholder} numberOfLines={1} ellipsizeMode="tail">
          {coachLabel ||
            (language === "he" ? "בחירת מאמן לפי שם…" : "Choose trainer by name…")}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.modalBackdropTouch}
            onPress={() => setOpen(false)}
            accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
          />
          <View style={styles.modalBox}>
            <View style={[styles.modalHeader, isRTL && styles.modalHeaderRtl]}>
              <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>
                {language === "he" ? "כל המאמנים" : "All trainers"}
              </Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={12} accessibilityRole="button">
                <Text style={styles.modalClose}>{t("common.ok")}</Text>
              </Pressable>
            </View>
            {loading ? (
              <ActivityIndicator size="large" color={theme.colors.text} style={styles.modalLoader} />
            ) : (
              <FlatList
                data={options}
                keyExtractor={(item) => item.user_id}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [
                      styles.pickerItem,
                      coachId === item.user_id && styles.pickerItemSelected,
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={() => pick(item)}
                  >
                    <View style={[styles.pickerItemLeading, isRTL && styles.pickerItemLeadingRtl]}>
                      {item.calendar_color ? (
                        <View style={[styles.coachColorDot, { backgroundColor: item.calendar_color }]} />
                      ) : null}
                      <View style={styles.pickerItemTextCol}>
                        <Text style={styles.pickerItemName} numberOfLines={1} ellipsizeMode="tail">
                          {item.full_name}
                        </Text>
                        <Text style={styles.pickerItemRole} numberOfLines={1} ellipsizeMode="tail">
                          @{item.username} · {item.role}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={styles.pickerEmpty}>
                    {language === "he" ? "עדיין אין מאמנים" : "No trainers yet"}
                  </Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  rtlText: { textAlign: "right" },
  sectionLabel: { fontWeight: "800", fontSize: 13, color: theme.colors.textMuted },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  modalBackdropTouch: { ...StyleSheet.absoluteFillObject },
  modalBox: {
    maxHeight: "70%",
    backgroundColor: theme.colors.surfaceElevated,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    paddingBottom: theme.spacing.lg,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  modalHeaderRtl: { flexDirection: "row-reverse" },
  modalTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text },
  modalClose: { fontSize: 15, fontWeight: "800", color: theme.colors.cta },
  modalLoader: { marginVertical: theme.spacing.xl },
  pickerItem: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  pickerItemSelected: { backgroundColor: theme.colors.surface },
  pickerItemLeading: { flexDirection: "row", alignItems: "center", gap: 10 },
  pickerItemLeadingRtl: { flexDirection: "row-reverse" },
  coachColorDot: { width: 10, height: 10, borderRadius: 5 },
  pickerItemTextCol: { flex: 1, minWidth: 0, gap: 2 },
  pickerItemName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  pickerItemRole: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  pickerEmpty: {
    padding: theme.spacing.lg,
    textAlign: "center",
    color: theme.colors.textMuted,
    fontWeight: "600",
  },
});
