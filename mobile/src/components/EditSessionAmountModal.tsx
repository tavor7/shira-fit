import { View, Text, TextInput, Pressable } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { PrimaryButton } from "./PrimaryButton";
import { formatISODateFull } from "../lib/dateFormat";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { paymentMethodHistoryLabel, SESSION_PAYMENT_METHOD_KEYS, type SessionPaymentMethodKey } from "../lib/paymentMethod";
import type { ParticipantHistoryRow } from "../types/database";
import type { LanguageCode } from "../i18n/translations";
import { participantHistoryStyles as styles } from "../screens/participantHistoryStyles";

type Props = {
  visible: boolean;
  onClose: () => void;
  busy: boolean;
  reg: ParticipantHistoryRow | null;
  method: SessionPaymentMethodKey | "";
  onMethodChange: (method: SessionPaymentMethodKey | "") => void;
  amountStr: string;
  onAmountStrChange: (value: string) => void;
  onSave: () => void;
  language: LanguageCode;
  isRTL: boolean;
  t: (key: string) => string;
};

export function EditSessionAmountModal({
  visible,
  onClose,
  busy,
  reg,
  method,
  onMethodChange,
  amountStr,
  onAmountStrChange,
  onSave,
  language,
  isRTL,
  t,
}: Props) {
  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="sheet"
      backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
      cardStyle={styles.modalBox}
    >
      <View style={styles.modalHeader}>
        <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>
          {language === "he" ? "עדכון סכום לאימון" : "Edit session amount"}
        </Text>
        <Pressable onPress={onClose}>
          <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
        </Pressable>
      </View>
      <View style={styles.addPayBody}>
        {reg ? (
          <>
            <Text style={[styles.hint, isRTL && styles.rtlText]}>
              {formatISODateFull(reg.session_date, language)} ·{" "}
              {formatSessionTimeRange(reg.start_time, reg.duration_minutes ?? 60)}
            </Text>
          </>
        ) : null}
        <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "אמצעי תשלום" : "Payment method"}</Text>
        <View style={styles.methodRow}>
          {(["", ...SESSION_PAYMENT_METHOD_KEYS] as const).map((m) => {
            const on = method === m;
            const label = m === "" ? (language === "he" ? "ללא" : "None") : paymentMethodHistoryLabel(m, language);
            return (
              <Pressable
                key={`editm:${m}`}
                onPress={() => onMethodChange(m)}
                disabled={busy}
                style={({ pressed }) => [
                  styles.methodChip,
                  on && styles.methodChipOn,
                  pressed && !on && { opacity: 0.9 },
                  busy && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.methodChipTxt, on && styles.methodChipTxtOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.label, isRTL && styles.rtlText]}>{language === "he" ? "סכום ששולם (₪)" : "Amount paid (₪)"}</Text>
        <TextInput
          value={amountStr}
          onChangeText={onAmountStrChange}
          keyboardType="decimal-pad"
          placeholder={language === "he" ? "למשל 90" : "e.g. 90"}
          placeholderTextColor={theme.colors.placeholderOnLight}
          style={styles.inputLight}
          editable={!busy && method !== ""}
        />
        <PrimaryButton label={t("common.save")} onPress={onSave} loading={busy} loadingLabel={t("common.loading")} />
      </View>
    </AppModal>
  );
}
