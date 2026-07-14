import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { ActionButton } from "./ActionButton";
import { parseCustomSlotPriceDraft } from "../lib/sessionSlotPrice";

export type SessionRateMeta = {
  max_participants: number;
  is_kickbox: boolean;
  session_date: string;
  custom_slot_price_ils: number | null;
};

type Props = {
  sessionId: string;
  userId: string | null;
  manualParticipantId: string | null;
  participantName: string;
  rosterPriceIls: number | null;
  effectivePriceIls: number;
  disabled?: boolean;
  onSaved: () => void;
};

export function formatRosterIls(n: number, language: string): string {
  const rounded = Math.round(n * 100) / 100;
  const s = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return language === "he" ? `${s} ₪` : `₪${s}`;
}

export function RosterSlotRateChip({
  sessionId,
  userId,
  manualParticipantId,
  participantName,
  rosterPriceIls,
  effectivePriceIls,
  disabled,
  onSaved,
}: Props) {
  const { t, isRTL, language } = useI18n();
  const { showOk } = useAppAlert();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const hasOverride = rosterPriceIls != null;
  const chipLabel = language === "he" ? "תעריף" : "Rate";

  useEffect(() => {
    if (!open) return;
    setDraft(rosterPriceIls != null ? String(rosterPriceIls) : "");
  }, [open, rosterPriceIls]);

  async function save() {
    const parsed = parseCustomSlotPriceDraft(draft);
    if (!parsed.ok) {
      showOk(t("common.error"), t("managerSession.customSlotPriceInvalid"));
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.rpc("staff_set_session_roster_slot_price", {
      p_session_id: sessionId,
      p_user_id: userId,
      p_manual_participant_id: manualParticipantId,
      p_price_ils: parsed.price,
    });
    setSaving(false);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.error"), data?.error ?? "");
      return;
    }
    setOpen(false);
    onSaved();
  }

  async function clearOverride() {
    setSaving(true);
    const { data, error } = await supabase.rpc("staff_set_session_roster_slot_price", {
      p_session_id: sessionId,
      p_user_id: userId,
      p_manual_participant_id: manualParticipantId,
      p_price_ils: null,
    });
    setSaving(false);
    if (error) {
      showOk(t("common.error"), error.message);
      return;
    }
    if (!data?.ok) {
      showOk(t("common.error"), data?.error ?? "");
      return;
    }
    setOpen(false);
    onSaved();
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${t("managerSession.rosterSlotRateTitle")}. ${chipLabel}`}
        style={({ pressed }) => [
          styles.chip,
          hasOverride && styles.chipCustom,
          isRTL && styles.chipRtl,
          disabled && styles.chipDisabled,
          pressed && !disabled && { opacity: 0.88 },
        ]}
      >
        <Ionicons
          name="pricetag-outline"
          size={13}
          color={hasOverride ? theme.colors.cta : theme.colors.textMuted}
          style={isRTL ? { marginLeft: 4 } : { marginRight: 4 }}
        />
        <Text style={[styles.chipTxt, hasOverride && styles.chipTxtCustom]} numberOfLines={1}>
          {chipLabel}
        </Text>
      </Pressable>

      <AppModal
        visible={open}
        onClose={() => !saving && setOpen(false)}
        variant="dialog"
        backdropAccessibilityLabel={t("common.cancel")}
      >
        <View style={styles.dialog}>
          <View style={[styles.sheetHeader, isRTL && styles.sheetHeaderRtl]}>
            <View style={styles.sheetHeaderText}>
              <Text style={[styles.sheetTitle, isRTL && styles.rtlText]}>{t("managerSession.rosterSlotRateTitle")}</Text>
              <Text style={[styles.sheetName, isRTL && styles.rtlText]} numberOfLines={2}>
                {participantName}
              </Text>
            </View>
            <Pressable
              onPress={() => !saving && setOpen(false)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
              style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </Pressable>
          </View>

          <View style={[styles.inputRow, isRTL && styles.inputRowRtl]}>
            <TextInput
              style={[styles.input, isRTL && styles.inputRtl, saving && styles.inputDisabled]}
              value={draft}
              onChangeText={setDraft}
              keyboardType="decimal-pad"
              placeholder={
                effectivePriceIls > 0 ? String(effectivePriceIls) : language === "he" ? "תעריף" : "Rate"
              }
              placeholderTextColor={theme.colors.placeholderOnLight}
              editable={!saving}
            />
            <Text style={styles.currency}>₪</Text>
          </View>

          <PrimaryButton
            label={t("managerSession.rosterSlotRateSave")}
            loading={saving}
            onPress={() => void save()}
            style={styles.saveBtn}
          />

          {hasOverride ? (
            <ActionButton
              label={t("managerSession.rosterSlotRateClear")}
              onPress={() => void clearOverride()}
              disabled={saving}
              style={styles.clearBtn}
            />
          ) : null}
        </View>
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  chipRtl: { flexDirection: "row-reverse" },
  chipCustom: {
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.infoBg,
  },
  chipDisabled: { opacity: 0.5 },
  chipTxt: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textMuted,
  },
  chipTxtCustom: { color: theme.colors.cta },
  dialog: { padding: theme.spacing.lg, gap: 10 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: theme.spacing.sm,
  },
  sheetHeaderRtl: { flexDirection: "row-reverse" },
  sheetHeaderText: { flex: 1, minWidth: 0 },
  sheetTitle: { fontSize: 17, fontWeight: "900", color: theme.colors.text },
  sheetName: { marginTop: 4, fontSize: 14, fontWeight: "600", color: theme.colors.textMuted },
  closeBtn: { padding: 4 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  inputRowRtl: { flexDirection: "row-reverse" },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
  },
  inputRtl: { textAlign: "right" },
  inputDisabled: { opacity: 0.6 },
  currency: { fontSize: 16, fontWeight: "800", color: theme.colors.textMuted },
  saveBtn: {
    marginTop: 6,
  },
  clearBtn: {
    alignSelf: "center",
  },
  rtlText: { writingDirection: "rtl", textAlign: "right" },
});
