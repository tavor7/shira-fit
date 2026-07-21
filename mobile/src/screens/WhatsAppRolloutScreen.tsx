import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { PrimaryButton } from "../components/PrimaryButton";
import { Skeleton } from "../components/Skeleton";
import { AnimatedOptionExpand } from "../components/AnimatedOptionExpand";
import { CrossfadeSwap } from "../components/CrossfadeSwap";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { useToast } from "../context/ToastContext";
import {
  fetchWhatsAppRolloutConfig,
  saveWhatsAppRolloutConfig,
  searchWhatsAppTestCandidates,
  sendWhatsAppManagerTestMessage,
  type WhatsAppRolloutMode,
  type WhatsAppTestCandidate,
  type WhatsAppTestUser,
} from "../lib/whatsappFeature";

const MODES: WhatsAppRolloutMode[] = ["off", "testing", "live"];

export default function WhatsAppRolloutScreen() {
  const { t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showOk, showConfirm } = useAppAlert();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMode, setSavedMode] = useState<WhatsAppRolloutMode>("off");
  const [mode, setMode] = useState<WhatsAppRolloutMode>("off");
  const [savedSelected, setSavedSelected] = useState<WhatsAppTestUser[]>([]);
  const [selected, setSelected] = useState<WhatsAppTestUser[]>([]);
  const [sendTargetId, setSendTargetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<WhatsAppTestCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const dirty = mode !== savedMode || JSON.stringify(selected.map((u) => u.user_id)) !== JSON.stringify(savedSelected.map((u) => u.user_id));

  const load = useCallback(async () => {
    setLoading(true);
    const cfg = await fetchWhatsAppRolloutConfig();
    setLoading(false);
    if (!cfg.ok) {
      showOk(t("common.error"), cfg.error ?? t("common.failed"));
      return;
    }
    const nextMode = cfg.mode ?? "off";
    const nextUsers = cfg.test_users ?? [];
    setMode(nextMode);
    setSavedMode(nextMode);
    setSelected(nextUsers);
    setSavedSelected(nextUsers);
    setSendTargetId((prev) => prev ?? nextUsers[0]?.user_id ?? null);
  }, [showOk, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode === "off") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const rows = await searchWhatsAppTestCandidates(search);
        if (!cancelled) {
          setHits(rows);
          setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, mode]);

  const selectedIds = useMemo(() => new Set(selected.map((u) => u.user_id)), [selected]);
  const sendTarget = selected.find((u) => u.user_id === sendTargetId) ?? selected[0] ?? null;

  function addCandidate(c: WhatsAppTestCandidate) {
    if (selectedIds.has(c.user_id)) {
      setSendTargetId(c.user_id);
      setSearch("");
      return;
    }
    const next = { user_id: c.user_id, full_name: c.full_name, phone: c.phone, role: c.role };
    setSelected((prev) => [...prev, next]);
    setSendTargetId(c.user_id);
    setSearch("");
  }

  function removeUser(userId: string) {
    setSelected((prev) => prev.filter((u) => u.user_id !== userId));
    if (sendTargetId === userId) {
      setSendTargetId(null);
    }
  }

  async function persist(nextMode: WhatsAppRolloutMode, opts?: { silent?: boolean }): Promise<boolean> {
    setSaving(true);
    const res = await saveWhatsAppRolloutConfig(
      nextMode,
      nextMode === "testing" ? selected.map((u) => u.user_id) : []
    );
    setSaving(false);
    if (!res.ok) {
      showOk(t("common.error"), res.error ?? t("common.failed"));
      return false;
    }
    setSavedMode(nextMode);
    setSavedSelected(selected);
    if (!opts?.silent) {
      showToast({
        message:
          nextMode === "testing"
            ? t("whatsapp.savedWithTesters").replace("{n}", String(res.count ?? selected.length))
            : t("whatsapp.saved"),
        variant: "success",
      });
    }
    return true;
  }

  function save() {
    if (mode === "live") {
      showConfirm({
        title: t("whatsapp.liveConfirmTitle"),
        message: t("whatsapp.liveConfirmBody"),
        cancelLabel: t("common.cancel"),
        confirmLabel: t("whatsapp.liveConfirmOk"),
        onConfirm: () => void persist("live"),
      });
      return;
    }
    if (savedMode === "live") {
      showConfirm({
        title: t("whatsapp.stepDownConfirmTitle"),
        message: t("whatsapp.stepDownConfirmBody"),
        cancelLabel: t("common.cancel"),
        confirmLabel: t("whatsapp.stepDownConfirmOk"),
        confirmVariant: "danger",
        onConfirm: () => void persist(mode),
      });
      return;
    }
    void persist(mode);
  }

  async function sendTestMessage() {
    if (!sendTarget) {
      showOk(t("common.error"), t("whatsapp.testPickUser"));
      return;
    }
    setSendingTest(true);
    try {
      if (dirty) {
        const saved = await persist(mode, { silent: true });
        if (!saved) return;
      }
      const res = await sendWhatsAppManagerTestMessage(sendTarget.user_id, "hello_world");
      if (!res.ok) {
        const errKey =
          res.error === "rollout_off"
            ? t("whatsapp.testRolloutOff")
            : res.error === "invalid_phone"
              ? t("whatsapp.testInvalidPhone")
              : res.error === "delivery_timeout"
                ? t("whatsapp.testDeliveryTimeout")
                : res.error?.includes("131030") || res.error?.toLowerCase().includes("not in allowed list")
                  ? t("whatsapp.testNotInAllowedList")
                  : res.error?.toLowerCase().includes("authentication")
                ? t("whatsapp.testAuthError")
                : res.error ?? t("common.failed");
        showOk(t("common.error"), errKey);
        return;
      }
      showToast({
        message: t("whatsapp.testSent").replace("{name}", res.user_name ?? sendTarget.full_name),
        variant: "success",
      });
    } finally {
      setSendingTest(false);
    }
  }

  const modeLabel = (m: WhatsAppRolloutMode) => {
    if (m === "off") return t("whatsapp.modeOff");
    if (m === "testing") return t("whatsapp.modeTesting");
    return t("whatsapp.modeLive");
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      <ManagerStudioSetupTabs />

      <Text style={[styles.title, isRTL && styles.rtl]}>{t("whatsapp.rolloutTitle")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>{t("whatsapp.rolloutSubtitle")}</Text>

      <CrossfadeSwap
        loading={loading}
        skeleton={
          <View style={styles.skeletonList}>
            <Skeleton height={120} radius={theme.radius.lg} />
            <Skeleton height={80} radius={theme.radius.lg} />
          </View>
        }
      >
        <>
          <View style={[styles.card, surface.card]}>
            <Text style={[styles.sectionEyebrow, isRTL && styles.rtl]}>{t("whatsapp.rolloutTitle")}</Text>
            <View style={[styles.modeRow, isRTL && styles.modeRowRtl]}>
              {MODES.map((m) => {
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => setMode(m)}
                    style={({ pressed }) => [styles.modeBtn, on && styles.modeBtnOn, pressed && !on && styles.pressed]}
                  >
                    <Text style={[styles.modeBtnTxt, on && styles.modeBtnTxtOn, isRTL && styles.rtl]} numberOfLines={1}>
                      {modeLabel(m)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <PrimaryButton
              label={dirty ? t("whatsapp.saveChanges") : t("whatsapp.save")}
              onPress={save}
              loading={saving}
              loadingLabel={t("common.loading")}
              style={styles.saveBtn}
            />
          </View>

          <AnimatedOptionExpand open={mode !== "off"}>
            <View style={[styles.card, surface.card]}>
              <Text style={[styles.sectionEyebrow, isRTL && styles.rtl]}>{t("whatsapp.testSendTitle")}</Text>
              <Text style={[styles.testHint, isRTL && styles.rtl]}>{t("whatsapp.testSendHintHello")}</Text>

              {selected.length > 0 ? (
                <View style={[styles.chips, isRTL && styles.chipsRtl]}>
                  {selected.map((u) => {
                    const active = sendTarget?.user_id === u.user_id;
                    return (
                      <View
                        key={u.user_id}
                        style={[styles.chip, styles.chipRemovable, active && styles.chipActive, isRTL && styles.chipRemovableRtl]}
                      >
                        <Pressable onPress={() => setSendTargetId(u.user_id)} style={({ pressed }) => [pressed && styles.pressed]}>
                          <Text style={[styles.chipTxt, active && styles.chipTxtActive, isRTL && styles.rtl]} numberOfLines={1}>
                            {u.full_name}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => removeUser(u.user_id)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={t("common.remove")}
                          style={({ pressed }) => [styles.chipRemove, pressed && { opacity: 0.7 }]}
                        >
                          <Text style={styles.chipRemoveTxt}>×</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              ) : null}

              <TextInput
                style={[styles.search, isRTL && styles.searchRtl]}
                placeholder={t("whatsapp.testPickUserPlaceholder")}
                placeholderTextColor={theme.colors.textSoft}
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
              />

              {searching ? <ActivityIndicator color={theme.colors.cta} /> : null}

              {search.trim().length > 0
                ? hits
                    .filter((h) => !selectedIds.has(h.user_id))
                    .slice(0, 4)
                    .map((h) => (
                      <Pressable
                        key={h.user_id}
                        onPress={() => addCandidate(h)}
                        style={({ pressed }) => [styles.hitRow, pressed && styles.pressed]}
                      >
                        <Text style={[styles.hitName, isRTL && styles.rtl]}>{h.full_name}</Text>
                        <Text style={[styles.hitMeta, isRTL && styles.rtl]}>
                          {h.role} · {h.phone}
                        </Text>
                      </Pressable>
                    ))
                : null}

              {sendTarget ? (
                <Text style={[styles.sendTo, isRTL && styles.rtl]}>
                  {t("whatsapp.testSendTo").replace("{name}", sendTarget.full_name).replace("{phone}", sendTarget.phone)}
                </Text>
              ) : null}

              <PrimaryButton
                label={t("whatsapp.testSendButton")}
                onPress={() => void sendTestMessage()}
                loading={sendingTest || saving}
                loadingLabel={t("common.loading")}
                disabled={!sendTarget}
              />
            </View>
          </AnimatedOptionExpand>

          {mode === "testing" && selected.length > 0 ? (
            <Pressable
              onPress={() => setManageOpen((v) => !v)}
              style={({ pressed }) => [styles.manageToggle, pressed && styles.pressed]}
            >
              <Text style={[styles.manageToggleTxt, isRTL && styles.rtl]}>
                {manageOpen ? t("whatsapp.hideTestUsers") : t("whatsapp.manageTestUsers")}
              </Text>
            </Pressable>
          ) : null}

          <AnimatedOptionExpand open={mode === "testing" && manageOpen}>
            <View style={[styles.card, surface.card]}>
              <Text style={[styles.testHint, isRTL && styles.rtl]}>{t("whatsapp.testUsersHint")}</Text>
              <View style={[styles.chips, isRTL && styles.chipsRtl]}>
                {selected.map((u) => (
                  <Pressable
                    key={u.user_id}
                    onPress={() => removeUser(u.user_id)}
                    style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                  >
                    <Text style={[styles.chipTxt, isRTL && styles.rtl]} numberOfLines={1}>
                      {u.full_name} ×
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </AnimatedOptionExpand>
        </>
      </CrossfadeSwap>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl + theme.spacing.md },
  title: { fontSize: 22, fontWeight: "900", color: theme.colors.text, letterSpacing: -0.3 },
  hint: { marginTop: 8, color: theme.colors.textMuted, lineHeight: 21, fontSize: 14, fontWeight: "500" },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  skeletonList: { marginTop: 24, gap: theme.spacing.md },
  card: { marginTop: theme.spacing.lg, padding: theme.spacing.md, borderRadius: theme.radius.lg, gap: 12 },
  sectionEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  modeRow: { flexDirection: "row", gap: 8 },
  modeRowRtl: { flexDirection: "row-reverse" },
  modeBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  modeBtnOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  modeBtnTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted },
  modeBtnTxtOn: { color: theme.colors.ctaText },
  pressed: { opacity: 0.9 },
  saveBtn: { marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipsRtl: { flexDirection: "row-reverse" },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxWidth: "100%",
  },
  chipActive: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surface },
  chipRemovable: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipRemovableRtl: { flexDirection: "row-reverse" },
  chipRemove: { marginLeft: 2 },
  chipRemoveTxt: { fontSize: 15, fontWeight: "900", color: theme.colors.textSoft, lineHeight: 16 },
  chipTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  chipTxtActive: { color: theme.colors.text },
  search: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceElevated,
  },
  searchRtl: { textAlign: "right" },
  hitRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  hitName: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  hitMeta: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  testHint: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 19 },
  sendTo: { fontSize: 13, fontWeight: "600", color: theme.colors.text },
  manageToggle: { marginTop: theme.spacing.md, paddingVertical: 8 },
  manageToggleTxt: { fontSize: 13, fontWeight: "700", color: theme.colors.textSoft },
});
