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
import { DatePickerField } from "../components/DatePickerField";
import { isValidISODateString } from "../lib/isoDate";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import { useAuth } from "../context/AuthContext";
import { AnimatedOptionExpand } from "../components/AnimatedOptionExpand";

/** How long the save checkmark holds before navigating back. */
const SAVE_SUCCESS_HOLD_MS = 1200;

export default function StaffEditProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const userId = String(id ?? "");
  const { t, isRTL, language } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const { profile } = useAuth();
  const isManager = profile?.role === "manager";

  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [dob, setDob] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [confirmingEmail, setConfirmingEmail] = useState(false);
  const [lastSignInAt, setLastSignInAt] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [disabledAt, setDisabledAt] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [togglingDisabled, setTogglingDisabled] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [settingTempPassword, setSettingTempPassword] = useState(false);
  const [tempPasswordResult, setTempPasswordResult] = useState<string | null>(null);
  const [duplicateNames, setDuplicateNames] = useState<
    { user_id: string; full_name: string; username: string; phone: string; role: string }[]
  >([]);
  const [duplicateNamesLoading, setDuplicateNamesLoading] = useState(false);

  const loadDuplicateNames = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || !userId) {
        setDuplicateNames([]);
        return;
      }
      setDuplicateNamesLoading(true);
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, username, phone, role")
        .ilike("full_name", trimmed)
        .neq("user_id", userId)
        .limit(20);
      setDuplicateNamesLoading(false);
      if (error) {
        setDuplicateNames([]);
        return;
      }
      const normalized = trimmed.toLowerCase();
      setDuplicateNames(
        ((data as { user_id: string; full_name: string; username: string; phone: string; role: string }[]) ?? []).filter(
          (row) => row.full_name.trim().toLowerCase() === normalized
        )
      );
    },
    [userId]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMetaLoading(true);
      const [profileRes, metaRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, phone, gender, date_of_birth, disabled_at, username, address, zip_code, must_change_password")
          .eq("user_id", userId)
          .single(),
        supabase.rpc("staff_get_user_auth_meta", { p_user_id: userId }),
      ]);
      setLoading(false);
      setMetaLoading(false);
      const { data, error } = profileRes;
      if (error || !data) return;
      setFullName((data as any).full_name ?? "");
      setPhone((data as any).phone ?? "");
      setAddress(String((data as any).address ?? "").trim());
      setZipCode(String((data as any).zip_code ?? "").trim());
      const g = String((data as any).gender ?? "").trim().toLowerCase();
      setGender(g === "male" || g === "female" ? (g as any) : "");
      setDob((data as any).date_of_birth ?? "");
      setDisabledAt(typeof (data as any).disabled_at === "string" ? (data as any).disabled_at : null);
      setUsername(String((data as any).username ?? "").trim());
      const pendingChange = (data as any).must_change_password === true;
      setMustChangePassword(pendingChange);
      if (pendingChange && isManager) {
        const { data: pwData } = await supabase.rpc("staff_get_temp_password", { p_user_id: userId });
        const pw = (pwData as { ok?: boolean; password?: string | null } | null)?.password;
        if (typeof pw === "string" && pw) setTempPasswordResult(pw);
      }

      const meta = metaRes.data as { ok?: boolean; last_sign_in_at?: string | null; email?: string | null } | null;
      if (meta?.ok) {
        setLastSignInAt(typeof meta.last_sign_in_at === "string" ? meta.last_sign_in_at : null);
        setEmail(typeof meta.email === "string" ? meta.email : "");
      }
    })();
  }, [userId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadDuplicateNames(fullName);
    }, 300);
    return () => clearTimeout(timer);
  }, [fullName, loadDuplicateNames]);

  async function save() {
    setSaving(true);
    // Important: omit optional params when empty.
    // Passing `null` sometimes prevents PostgREST from resolving the correct
    // function signature in the schema cache (it can't infer types for nulls).
    const payload: Record<string, unknown> = { p_user_id: userId };
    const full = fullName.trim();
    const ph = phone.trim();
    const gen = gender;
    const dobTrim = dob.trim();

    if (full.length > 0) payload.p_full_name = full;
    if (ph.length > 0) payload.p_phone = ph;
    if (gen.length > 0) payload.p_gender = gen;
    if (dobTrim.length > 0 && isValidISODateString(dobTrim)) payload.p_date_of_birth = dobTrim;
    payload.p_address = address.trim();
    payload.p_zip_code = zipCode.trim();

    const { data, error } = await supabase.rpc("staff_update_profile_text", payload as any);
    setSaving(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.ok) {
      showToast({ message: t("common.failed"), detail: data?.error ?? "Unknown error", variant: "error" });
      return;
    }
    showToast({ message: t("common.saved"), variant: "success" });
    setSaveSuccess(true);
    await new Promise((resolve) => setTimeout(resolve, SAVE_SUCCESS_HOLD_MS));
    router.back();
  }

  async function toggleAccountDisabled() {
    if (togglingDisabled) return;
    const disabling = disabledAt == null;
    showConfirm({
      title: disabling ? t("profile.disableAccountTitle") : t("profile.enableAccountTitle"),
      message: disabling ? t("profile.disableAccountMessage") : t("profile.enableAccountMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: disabling ? t("profile.disableAccountConfirm") : t("profile.enableAccountConfirm"),
      confirmVariant: disabling ? "danger" : "primary",
      onConfirm: () => {
        void (async () => {
          setTogglingDisabled(true);
          const { data, error } = await supabase.rpc("staff_set_account_disabled", {
            p_user_id: userId,
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

  function setTempPassword() {
    if (!isManager) return;
    const uid = userId.trim();
    if (!uid || settingTempPassword) return;
    showConfirm({
      title: t("profile.tempPasswordConfirmTitle"),
      message: t("profile.tempPasswordConfirmMessage"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("profile.tempPasswordConfirmAction"),
      confirmVariant: "primary",
      onConfirm: () => {
        void (async () => {
          setSettingTempPassword(true);
          const { data, error } = await supabase.functions.invoke("staff-set-temp-password", {
            body: { user_id: uid },
          });
          setSettingTempPassword(false);
          if (error) {
            showToast({ message: t("common.error"), detail: error.message, variant: "error" });
            return;
          }
          if (!data?.ok) {
            showToast({ message: t("common.failed"), detail: String(data?.error ?? ""), variant: "error" });
            return;
          }
          setTempPasswordResult(String(data.password ?? ""));
          setMustChangePassword(true);
          showToast({ message: t("profile.tempPasswordGenerated"), variant: "success" });
        })();
      },
    });
  }

  async function confirmEmail() {
    if (!isManager) return;
    const uid = userId.trim();
    if (!uid) return;
    if (confirmingEmail) return;
    setConfirmingEmail(true);
    const { data, error } = await supabase.functions.invoke("staff-confirm-email", {
      body: { user_id: uid },
    });
    setConfirmingEmail(false);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      return;
    }
    if (!data?.ok) {
      showToast({ message: t("common.failed"), detail: String(data?.error ?? ""), variant: "error" });
      return;
    }
    showToast({
      message: t("profile.emailConfirmed"),
      variant: "success",
    });
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <AppText variant="headline" isRTL={isRTL} style={styles.title}>
        {t("profile.editUser")}
      </AppText>
      {loading ? (
        <AppText muted isRTL={isRTL} style={styles.muted}>
          {t("common.loading")}
        </AppText>
      ) : null}

      {userId ? (
        <View style={styles.metaCard}>
          {username ? (
            <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
              <AppText variant="label" soft isRTL={isRTL}>
                {t("profile.username")}
              </AppText>
              <AppText isRTL={isRTL} selectable numberOfLines={2}>
                @{username}
              </AppText>
            </View>
          ) : null}
          <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
            <AppText variant="label" soft isRTL={isRTL}>
              {t("auth.email")}
            </AppText>
            <AppText isRTL={isRTL} selectable numberOfLines={2}>
              {metaLoading ? t("common.loading") : email.trim() || "—"}
            </AppText>
          </View>
          <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
            <AppText variant="label" soft isRTL={isRTL}>
              {t("profile.lastLogin")}
            </AppText>
            <AppText isRTL={isRTL} numberOfLines={2}>
              {metaLoading
                ? t("common.loading")
                : lastSignInAt
                  ? formatDateTimeForDisplay(lastSignInAt, language)
                  : t("profile.neverLoggedIn")}
            </AppText>
          </View>
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
          {mustChangePassword ? (
            <View style={[styles.metaRow, isRTL && styles.metaRowRtl]}>
              <AppText variant="label" soft isRTL={isRTL}>
                {t("profile.accountStatus")}
              </AppText>
              <AppText isRTL={isRTL} style={styles.metaPending} numberOfLines={2}>
                {t("profile.mustChangePasswordBadge")}
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}

      {tempPasswordResult ? (
        <View style={styles.tempPasswordCard}>
          <AppText variant="label" isRTL={isRTL} style={styles.tempPasswordTitle}>
            {t("profile.tempPasswordResultLabel")}
          </AppText>
          <AppText selectable isRTL={isRTL} style={styles.tempPasswordValue}>
            {tempPasswordResult}
          </AppText>
          <AppText variant="caption" isRTL={isRTL} style={styles.tempPasswordHint}>
            {t("profile.tempPasswordResultHint")}
          </AppText>
        </View>
      ) : null}

      <AppTextField
        label={t("profile.fullName")}
        value={fullName}
        onChangeText={setFullName}
        isRTL={isRTL}
        containerStyle={styles.field}
      />
      {duplicateNamesLoading ? (
        <AppText variant="caption" muted isRTL={isRTL} style={styles.duplicateHint}>
          {t("common.loading")}
        </AppText>
      ) : null}
      <AnimatedOptionExpand open={duplicateNames.length > 0}>
        <View style={styles.duplicateCard}>
          <AppText variant="caption" isRTL={isRTL} style={styles.duplicateTitle}>
            {t("profile.duplicateNameTitle").replace("{n}", String(duplicateNames.length))}
          </AppText>
          {duplicateNames.map((row) => (
            <Pressable
              key={row.user_id}
              onPress={() => router.push(`/(app)/staff/profile/${row.user_id}` as never)}
              style={({ pressed }) => [styles.duplicateRow, pressed && { opacity: 0.88 }]}
              accessibilityRole="button"
            >
              <AppText variant="caption" isRTL={isRTL} style={styles.duplicateRowTxt} numberOfLines={2}>
                {t("profile.duplicateNameLine")
                  .replace("{username}", row.username)
                  .replace("{phone}", row.phone || "—")
                  .replace("{role}", row.role)}
              </AppText>
            </Pressable>
          ))}
        </View>
      </AnimatedOptionExpand>

      <AppTextField
        label={t("profile.phone")}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.address")}
        value={address}
        onChangeText={setAddress}
        placeholder={t("profile.address")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppTextField
        label={t("profile.zipCode")}
        value={zipCode}
        onChangeText={setZipCode}
        keyboardType="number-pad"
        placeholder={t("profile.zipCode")}
        isRTL={isRTL}
        containerStyle={styles.field}
      />

      <AppText variant="label" muted isRTL={isRTL} style={styles.genderLabel}>
        {t("profile.gender")}
      </AppText>
      <View style={[styles.genderRow, isRTL && styles.genderRowRtl]}>
        <Pressable
          onPress={() => setGender("male")}
          style={({ pressed }) => [styles.genderBtn, gender === "male" && styles.genderBtnOn, pressed && { opacity: 0.9 }]}
          accessibilityRole="button"
        >
          <AppText style={[styles.genderTxt, gender === "male" && styles.genderTxtOn]}>{t("profile.male")}</AppText>
        </Pressable>
        <Pressable
          onPress={() => setGender("female")}
          style={({ pressed }) => [styles.genderBtn, gender === "female" && styles.genderBtnOn, pressed && { opacity: 0.9 }]}
          accessibilityRole="button"
        >
          <AppText style={[styles.genderTxt, gender === "female" && styles.genderTxtOn]}>{t("profile.female")}</AppText>
        </Pressable>
      </View>

      <DatePickerField label={t("profile.dob")} value={dob} onChange={setDob} />

      <PrimaryButton
        label={t("common.save")}
        onPress={save}
        loading={saving}
        success={saveSuccess}
        loadingLabel={t("common.loading")}
        style={styles.saveBtn}
      />

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

      {isManager ? (
        <Pressable
          onPress={setTempPassword}
          disabled={settingTempPassword}
          style={({ pressed }) => [
            styles.tempPasswordBtn,
            settingTempPassword && { opacity: 0.6 },
            pressed && !settingTempPassword && { opacity: 0.9 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("profile.setTempPassword")}
        >
          <AppText style={styles.tempPasswordBtnTxt}>
            {settingTempPassword ? t("common.loading") : t("profile.setTempPassword")}
          </AppText>
        </Pressable>
      ) : null}

      {isManager ? (
        <Pressable
          onPress={confirmEmail}
          disabled={confirmingEmail}
          style={({ pressed }) => [
            styles.confirmEmailBtn,
            confirmingEmail && { opacity: 0.6 },
            pressed && !confirmingEmail && { opacity: 0.9 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("profile.confirmEmail")}
        >
          <AppText style={styles.confirmEmailTxt}>
            {confirmingEmail ? t("common.loading") : t("profile.confirmEmail")}
          </AppText>
        </Pressable>
      ) : null}

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
  field: { marginTop: theme.spacing.sm },
  genderLabel: { marginTop: theme.spacing.sm, marginBottom: theme.spacing.xs },
  saveBtn: { marginTop: theme.spacing.md },
  metaCard: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
    gap: theme.spacing.sm,
  },
  metaRow: { gap: 4 },
  metaRowRtl: { alignItems: "flex-end" },
  metaDisabled: { color: theme.colors.error },
  metaPending: { color: theme.colors.cta },
  tempPasswordCard: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.infoBg,
    gap: 4,
  },
  tempPasswordTitle: { color: theme.colors.textMuted },
  tempPasswordValue: { fontSize: 22, fontWeight: "900", letterSpacing: 0.5 },
  tempPasswordHint: { color: theme.colors.textSoft, lineHeight: 18 },
  tempPasswordBtn: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tempPasswordBtnTxt: { color: theme.colors.text, fontWeight: "900", letterSpacing: 0.2 },
  disableAccountBtn: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.error,
    backgroundColor: theme.colors.errorBg,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  disableAccountTxt: { color: theme.colors.error, fontWeight: "900", letterSpacing: 0.2 },
  enableAccountBtn: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  enableAccountTxt: { color: theme.colors.text, fontWeight: "900", letterSpacing: 0.2 },
  rtlText: { textAlign: "right" },
  genderRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  genderRowRtl: { flexDirection: "row-reverse" },
  genderBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  genderBtnOn: {
    backgroundColor: theme.colors.cta,
    borderColor: theme.colors.cta,
  },
  genderTxt: { fontWeight: "900", color: theme.colors.textMuted, letterSpacing: 0.2 },
  genderTxtOn: { color: theme.colors.ctaText },
  duplicateHint: { marginTop: 6 },
  duplicateCard: {
    marginTop: 8,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.infoBg,
    gap: 6,
  },
  duplicateTitle: { lineHeight: 17 },
  duplicateRow: { paddingVertical: 4 },
  duplicateRowTxt: { color: theme.colors.cta, lineHeight: 18 },
  confirmEmailBtn: {
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmEmailTxt: { color: theme.colors.text, fontWeight: "900", letterSpacing: 0.2 },
  cancel: { marginTop: theme.spacing.md, alignSelf: "center" },
  cancelTxt: { color: theme.colors.textMuted, fontWeight: "800" },
});

