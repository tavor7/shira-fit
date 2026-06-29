import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { AppTextField } from "../components/AppTextField";
import { AppText } from "../components/AppText";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { formatDateTimeForDisplay, formatISODateFull } from "../lib/dateFormat";
import {
  participantNamesMatch,
  participantPhonesMatch,
  type ManualParticipantIdentity,
} from "../lib/participantIdentity";

export default function StaffEditManualParticipantScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const manualId = String(id ?? "");
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();

  const [loading, setLoading] = useState(true);
  const [metaLoading, setMetaLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState("");
  const [dob, setDob] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [disabledAt, setDisabledAt] = useState<string | null>(null);
  const [togglingDisabled, setTogglingDisabled] = useState(false);
  const [lastSessionDate, setLastSessionDate] = useState<string | null>(null);
  const [lastSessionAddedAt, setLastSessionAddedAt] = useState<string | null>(null);
  const [duplicateRows, setDuplicateRows] = useState<ManualParticipantIdentity[]>([]);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [baseline, setBaseline] = useState<{
    full_name: string;
    phone: string;
    gender: string | null;
    date_of_birth: string | null;
    notes: string | null;
  } | null>(null);

  const loadDuplicates = useCallback(
    async (row: { full_name: string; phone: string }) => {
      setDuplicatesLoading(true);
      const { data, error } = await supabase.from("manual_participants").select("id, full_name, phone");
      setDuplicatesLoading(false);
      if (error) {
        setDuplicateRows([]);
        return;
      }
      setDuplicateRows(
        ((data as ManualParticipantIdentity[]) ?? []).filter(
          (other) =>
            other.id !== manualId &&
            (participantNamesMatch(row.full_name, other.full_name) ||
              participantPhonesMatch(row.phone, other.phone))
        )
      );
    },
    [manualId]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMetaLoading(true);
      const [profileRes, metaRes] = await Promise.all([
        supabase
          .from("manual_participants")
          .select("full_name, phone, gender, date_of_birth, notes, disabled_at")
          .eq("id", manualId)
          .single(),
        supabase.rpc("staff_get_manual_participant_meta", { p_manual_participant_id: manualId }),
      ]);
      setLoading(false);
      setMetaLoading(false);
      const { data, error } = profileRes;
      if (error || !data) return;
      const row = data as {
        full_name: string;
        phone: string;
        gender: string | null;
        date_of_birth: string | null;
        notes: string | null;
        disabled_at: string | null;
      };
      setBaseline(row);
      setFullName(row.full_name ?? "");
      setPhone(row.phone ?? "");
      setGender(row.gender ?? "");
      setDob(row.date_of_birth ?? "");
      setNotes(row.notes ?? "");
      setDisabledAt(typeof row.disabled_at === "string" ? row.disabled_at : null);
      void loadDuplicates(row);

      const meta = metaRes.data as {
        ok?: boolean;
        last_session_date?: string | null;
        last_session_added_at?: string | null;
      } | null;
      if (meta?.ok) {
        setLastSessionDate(typeof meta.last_session_date === "string" ? meta.last_session_date : null);
        setLastSessionAddedAt(
          typeof meta.last_session_added_at === "string" ? meta.last_session_added_at : null
        );
      }
    })();
  }, [manualId, loadDuplicates]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadDuplicates({ full_name: fullName, phone });
    }, 300);
    return () => clearTimeout(timer);
  }, [fullName, phone, loadDuplicates]);

  async function save() {
    if (!baseline) return;
    setSaving(true);
    const patch = {
      full_name: fullName.trim() || baseline.full_name,
      phone: phone.trim() || baseline.phone,
      gender: (gender.trim() ? gender.trim() : baseline.gender) as string | null,
      date_of_birth: (dob.trim() ? dob.trim() : baseline.date_of_birth) as string | null,
      notes: notes as string | null,
    };
    const { data, error } = await supabase.from("manual_participants").update(patch).eq("id", manualId).select("id");
    setSaving(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.length) {
      showToast({
        message: t("common.failed"),
        detail: t("manualParticipant.notFoundOrNoPermission"),
        variant: "error",
      });
      return;
    }
    showToast({ message: t("common.saved"), variant: "success" });
    router.back();
  }

  async function toggleAccountDisabled() {
    if (togglingDisabled) return;
    const disabling = disabledAt == null;
    showConfirm({
      title: disabling ? t("profile.disableAccountTitle") : t("profile.enableAccountTitle"),
      message: disabling ? t("manualParticipant.disableMessage") : t("profile.enableAccountMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: disabling ? t("profile.disableAccountConfirm") : t("profile.enableAccountConfirm"),
      confirmVariant: disabling ? "danger" : "primary",
      onConfirm: () => {
        void (async () => {
          setTogglingDisabled(true);
          const { data, error } = await supabase.rpc("staff_set_manual_participant_disabled", {
            p_manual_participant_id: manualId,
            p_disabled: disabling,
          });
          setTogglingDisabled(false);
          if (error) {
            showToast({ message: t("common.error"), detail: error.message, variant: "error" });
            return;
          }
          if (!data?.ok) {
            showToast({ message: t("common.failed"), detail: String(data?.error ?? ""), variant: "error" });
            return;
          }
          setDisabledAt(disabling ? new Date().toISOString() : null);
          showToast({
            message: disabling ? t("profile.accountDisabledToast") : t("profile.accountEnabledToast"),
            variant: "success",
          });
        })();
      },
    });
  }

  const isDisabled = disabledAt != null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <AppText variant="headline" isRTL={isRTL} style={styles.title}>
        {t("manualParticipant.editTitle")}
      </AppText>
      {loading ? (
        <AppText muted isRTL={isRTL} style={styles.muted}>
          {t("common.loading")}
        </AppText>
      ) : null}

      {manualId ? (
        <View style={styles.metaCard}>
          <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
            <AppText variant="label" soft isRTL={isRTL}>
              {t("manualParticipant.lastSession")}
            </AppText>
            <AppText isRTL={isRTL} numberOfLines={2}>
              {metaLoading
                ? t("common.loading")
                : lastSessionDate
                  ? formatISODateFull(lastSessionDate, language)
                  : t("manualParticipant.neverInSession")}
            </AppText>
          </View>
          {lastSessionAddedAt ? (
            <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
              <AppText variant="label" soft isRTL={isRTL}>
                {t("manualParticipant.lastSessionAdded")}
              </AppText>
              <AppText isRTL={isRTL} numberOfLines={2}>
                {formatDateTimeForDisplay(lastSessionAddedAt, language)}
              </AppText>
            </View>
          ) : null}
          {isDisabled ? (
            <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
              <AppText variant="label" soft isRTL={isRTL}>
                {t("profile.accountStatus")}
              </AppText>
              <AppText isRTL={isRTL} style={styles.metaDisabled} numberOfLines={2}>
                {t("profile.accountDisabledSince").replace(
                  "{date}",
                  formatDateTimeForDisplay(disabledAt!, language)
                )}
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}

      <AppTextField
        label={t("profile.fullName")}
        value={fullName}
        onChangeText={setFullName}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      {duplicatesLoading ? (
        <AppText variant="caption" muted isRTL={isRTL} style={styles.duplicateHint}>
          {t("common.loading")}
        </AppText>
      ) : duplicateRows.length > 0 ? (
        <View style={styles.duplicateCard}>
          <AppText variant="caption" isRTL={isRTL} style={styles.duplicateTitle}>
            {t("manualParticipant.duplicateRecordsTitle").replace("{n}", String(duplicateRows.length))}
          </AppText>
          {duplicateRows.map((row) => (
            <Pressable
              key={row.id}
              onPress={() => router.push(`/(app)/staff/manual/${row.id}` as never)}
              style={({ pressed }) => [styles.duplicateRow, pressed && { opacity: 0.88 }]}
              accessibilityRole="button"
            >
              <AppText variant="caption" isRTL={isRTL} style={styles.duplicateRowTxt} numberOfLines={2}>
                {t("manualParticipant.duplicateRecordLine")
                  .replace("{name}", row.full_name || "—")
                  .replace("{phone}", row.phone || "—")}
              </AppText>
            </Pressable>
          ))}
        </View>
      ) : null}

      <AppTextField
        label={t("profile.phone")}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.gender")}
        value={gender}
        onChangeText={setGender}
        placeholder={t("manualParticipant.genderPlaceholder")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.dob")}
        value={dob}
        onChangeText={setDob}
        placeholder={t("manualParticipant.dobPlaceholder")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("manualParticipant.notes")}
        value={notes}
        onChangeText={setNotes}
        placeholder={t("manualParticipant.notesOptional")}
        isRTL={isRTL}
        multiline
        containerStyle={styles.field}
        style={styles.notesInput}
      />

      <PrimaryButton label={t("common.save")} onPress={save} loading={saving} loadingLabel={t("common.loading")} />

      <Pressable
        onPress={() => void toggleAccountDisabled()}
        disabled={togglingDisabled || loading}
        style={({ pressed }) => [
          isDisabled ? styles.enableAccountBtn : styles.disableAccountBtn,
          (togglingDisabled || loading) && { opacity: 0.6 },
          pressed && !togglingDisabled && !loading && { opacity: 0.9 },
        ]}
        accessibilityRole="button"
      >
        <AppText style={[isDisabled ? styles.enableAccountTxt : styles.disableAccountTxt, isRTL && styles.rtlText]}>
          {togglingDisabled
            ? t("common.loading")
            : isDisabled
              ? t("profile.enableAccountConfirm")
              : t("profile.disableAccountConfirm")}
        </AppText>
      </Pressable>

      <Pressable
        onPress={() => router.replace("/(app)/staff/users")}
        style={({ pressed }) => [styles.backToList, pressed && { opacity: 0.9 }]}
      >
        <AppText style={styles.backToListTxt}>{t("common.backToUsers")}</AppText>
      </Pressable>

      <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.9 }]}>
        <AppText muted style={styles.cancelTxt}>
          {t("common.cancel")}
        </AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scrollContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xl * 2,
  },
  title: { marginBottom: theme.spacing.sm },
  muted: { marginBottom: theme.spacing.sm },
  metaCard: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: theme.spacing.sm,
  },
  metaRow: { gap: 4 },
  metaRowRtl: { alignItems: "flex-end" },
  metaDisabled: { color: theme.colors.warning, fontWeight: "800" },
  field: { marginTop: theme.spacing.sm },
  duplicateHint: { marginTop: theme.spacing.xs },
  duplicateCard: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    backgroundColor: "rgba(96, 165, 250, 0.08)",
    gap: theme.spacing.xs,
  },
  duplicateTitle: { fontWeight: "800", color: theme.colors.cta },
  duplicateRow: { paddingVertical: 6, minHeight: 36, justifyContent: "center" },
  duplicateRowTxt: { color: theme.colors.text },
  notesInput: { minHeight: 90, textAlignVertical: "top" },
  disableAccountBtn: {
    marginTop: theme.spacing.md,
    paddingVertical: 14,
    borderRadius: theme.radius.lg,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  disableAccountTxt: { color: "#f87171", fontWeight: "900" },
  enableAccountBtn: {
    marginTop: theme.spacing.md,
    paddingVertical: 14,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  enableAccountTxt: { color: theme.colors.cta, fontWeight: "900" },
  rtlText: { textAlign: "right" },
  backToList: { marginTop: theme.spacing.md, alignSelf: "center", minHeight: 44, justifyContent: "center" },
  backToListTxt: { color: theme.colors.cta, fontWeight: "800" },
  cancel: { marginTop: theme.spacing.md, alignSelf: "center", minHeight: 44, justifyContent: "center" },
  cancelTxt: { fontWeight: "800" },
});
