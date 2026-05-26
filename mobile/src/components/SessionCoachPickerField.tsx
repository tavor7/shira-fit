import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { useI18n } from "../context/I18nContext";
import { CoachPickerSheet } from "./CoachPickerSheet";

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

  const fieldLabel = label ?? (language === "he" ? "מאמן" : "Trainer");

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

      <CoachPickerSheet
        visible={open}
        onClose={() => setOpen(false)}
        selectedCoachId={coachId}
        onSelect={(coach) => {
          onSelect({
            user_id: coach.user_id,
            full_name: coach.full_name,
            role: coach.role,
            username: coach.username,
            calendar_color: coach.calendar_color,
          });
          setOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  rtlText: { textAlign: "right" },
  sectionLabel: { fontWeight: "800", fontSize: 13, color: theme.colors.textMuted },
});
