import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AnimatedOptionExpand } from "./AnimatedOptionExpand";

type Props = {
  name: string;
  phone: string;
  onNameChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onSubmit: () => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  /** Collapse the panel (e.g. while the keyboard is open so search results have room). */
  forceCollapsed?: boolean;
};

/** Collapsible quick-add strip for participant pickers (no account). */
export function ParticipantQuickAddPanel({
  name,
  phone,
  onNameChange,
  onPhoneChange,
  onSubmit,
  busy,
  disabled,
  forceCollapsed = false,
}: Props) {
  const { t, isRTL } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const canSubmit = name.trim().length >= 2 && phone.trim().length >= 3 && !busy && !disabled;

  useEffect(() => {
    if (!name.trim() && !phone.trim()) setExpanded(false);
  }, [name, phone]);

  useEffect(() => {
    if (forceCollapsed) setExpanded(false);
  }, [forceCollapsed]);

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded((o) => !o)}
        disabled={disabled}
        style={({ pressed }) => [styles.headBtn, pressed && { opacity: 0.92 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t("sessionForm.quickAdd")}
      >
        <View style={[styles.head, isRTL && styles.headRtl]}>
          <View style={styles.iconWrap}>
            <Text style={styles.icon}>+</Text>
          </View>
          <View style={styles.headText}>
            <Text style={[styles.title, isRTL && styles.rtl]}>{t("sessionForm.quickAdd")}</Text>
            <Text style={[styles.hint, isRTL && styles.rtl]}>
              {expanded ? t("sessionForm.quickAddHint") : t("sessionForm.quickAddTapToExpand")}
            </Text>
          </View>
          <Text style={[styles.chevron, expanded && styles.chevronOpen, isRTL && styles.chevronRtl]}>›</Text>
        </View>
      </Pressable>

      <AnimatedOptionExpand open={expanded}>
        <View style={styles.body}>
          <View style={[styles.fields, isRTL && styles.fieldsRtl]}>
            <TextInput
              value={name}
              onChangeText={onNameChange}
              placeholder={t("profile.fullName")}
              placeholderTextColor={theme.colors.textSoft}
              style={[styles.input, isRTL && styles.inputRtl]}
              editable={!busy && !disabled}
            />
            <TextInput
              value={phone}
              onChangeText={onPhoneChange}
              placeholder={t("profile.phone")}
              placeholderTextColor={theme.colors.textSoft}
              style={[styles.input, isRTL && styles.inputRtl]}
              keyboardType="phone-pad"
              editable={!busy && !disabled}
            />
          </View>
          <Pressable
            onPress={() => void onSubmit()}
            disabled={!canSubmit}
            style={({ pressed }) => [
              styles.submit,
              canSubmit && styles.submitReady,
              pressed && canSubmit && { opacity: 0.9 },
              !canSubmit && { opacity: 0.45 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("sessionForm.addToTrainees")}
          >
            <Text style={[styles.submitTxt, canSubmit && styles.submitTxtReady]}>
              {busy ? t("common.loading") : t("sessionForm.addToTrainees")}
            </Text>
          </Pressable>
        </View>
      </AnimatedOptionExpand>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  headBtn: { padding: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  headRtl: { flexDirection: "row-reverse" },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { color: theme.colors.cta, fontSize: 20, fontWeight: "900", lineHeight: 22 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  hint: { marginTop: 2, fontSize: 11, fontWeight: "600", color: theme.colors.textSoft, lineHeight: 15 },
  chevron: {
    fontSize: 22,
    fontWeight: "700",
    color: theme.colors.textMuted,
    transform: [{ rotate: "90deg" }],
    marginStart: 4,
  },
  chevronOpen: { transform: [{ rotate: "-90deg" }] },
  chevronRtl: { transform: [{ rotate: "-90deg" }] },
  body: { paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
  fields: { flexDirection: "row", gap: 8 },
  fieldsRtl: { flexDirection: "row-reverse" },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 12,
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  submit: {
    minHeight: 44,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  submitReady: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  submitTxt: { fontSize: 14, fontWeight: "800", color: theme.colors.textMuted },
  submitTxtReady: { color: theme.colors.ctaText },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
