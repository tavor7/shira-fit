import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { AppText } from "./AppText";
import { AppTextField } from "./AppTextField";
import { PrimaryButton } from "./PrimaryButton";
import { ActionButton } from "./ActionButton";
import { AppModal } from "./AppModal";
import { ManagerMessageCard } from "./ManagerMessageCard";
import { FadeSlideIn } from "./FadeSlideIn";
import { CrossfadeSwap } from "./CrossfadeSwap";
import {
  cancelManagerDirectMessage,
  fetchSentManagerDirectMessages,
  initialsFromName,
  searchMessageRecipients,
  sendManagerDirectMessage,
  type MessageRecipient,
  type SentManagerMessage,
  type ManagerMessageTheme,
} from "../lib/managerDirectMessages";
import {
  MANAGER_MESSAGE_THEMES,
  getManagerMessageThemeStyle,
  managerMessageThemeLabelKey,
} from "../lib/managerMessageThemes";
import { formatISODateDayMonthWithWeekday, parseInstantIso } from "../lib/dateFormat";
import { appLocale } from "../lib/appLocale";

const STUDIO_TZ = "Asia/Jerusalem";

function formatSentWhen(iso: string, language: "en" | "he"): string {
  const d = parseInstantIso(iso);
  if (!d) return iso;
  const datePart = d.toLocaleDateString("en-CA", { timeZone: STUDIO_TZ });
  const dateFormatted = formatISODateDayMonthWithWeekday(datePart, language);
  const timeStudio = d.toLocaleTimeString(appLocale(language), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: STUDIO_TZ,
  });
  return `${dateFormatted} · ${timeStudio}`;
}

type Step = "pick" | "compose";

export function ManagerSendMessagePanel() {
  const { t, isRTL, language } = useI18n();
  const { profile } = useAuth();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const [step, setStep] = useState<Step>("pick");
  const [messageTheme, setMessageTheme] = useState<ManagerMessageTheme>("love");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<MessageRecipient[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MessageRecipient | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentManagerMessage[]>([]);
  const [loadingSent, setLoadingSent] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [previewSent, setPreviewSent] = useState<SentManagerMessage | null>(null);

  const loadSent = useCallback(async () => {
    setLoadingSent(true);
    setSent(await fetchSentManagerDirectMessages());
    setLoadingSent(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadSent();
    }, [loadSent])
  );

  useEffect(() => {
    if (search.trim().length === 0) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const rows = await searchMessageRecipients(search);
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
  }, [search]);

  const canSend = useMemo(
    () => !!selected && body.trim().length > 0 && body.trim().length <= 2000 && !sending,
    [selected, body, sending]
  );

  function pickUser(user: MessageRecipient) {
    setSelected(user);
    setSearch("");
    setHits([]);
    setError(null);
    setStep("compose");
  }

  function backToPick() {
    setStep("pick");
    setSelected(null);
    setBody("");
    setMessageTheme("love");
    setError(null);
  }

  const previewSenderName = profile?.full_name?.trim() || t("managerMessage.studioFallback");

  async function onSend() {
    if (!selected || !canSend) return;
    setError(null);
    setSending(true);
    const res = await sendManagerDirectMessage(selected.user_id, body, messageTheme);
    setSending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast({ message: t("managerMessage.sentOk"), variant: "success" });
    setBody("");
    setSelected(null);
    setMessageTheme("love");
    setStep("pick");
    void loadSent();
  }

  function confirmCancel(row: SentManagerMessage) {
    showConfirm({
      title: t("managerMessage.cancelTitle"),
      message: t("managerMessage.cancelConfirm"),
      confirmLabel: t("managerMessage.cancelAction"),
      cancelLabel: t("common.cancel"),
      confirmVariant: "danger",
      onConfirm: () => void cancelMessage(row.id),
    });
  }

  async function cancelMessage(messageId: string) {
    if (cancellingId) return;
    setCancellingId(messageId);
    const res = await cancelManagerDirectMessage(messageId);
    setCancellingId(null);
    if (!res.ok) {
      const detail =
        res.error === "not_found_or_already_read"
          ? t("managerMessage.cancelAlreadyRead")
          : res.error;
      showToast({ message: t("common.error"), detail, variant: "error" });
      void loadSent();
      return;
    }
    showToast({ message: t("managerMessage.cancelledOk"), variant: "success" });
    void loadSent();
  }

  return (
    <View style={styles.wrap}>
      <AppModal
        visible={previewSent !== null}
        onClose={() => setPreviewSent(null)}
        variant="dialog"
        animationType="fade"
        backdropAccessibilityLabel={t("common.close")}
        backdropStyle={styles.previewModalBackdrop}
        cardStyle={styles.previewModalCard}
      >
        {previewSent ? (
          <View style={styles.previewModalBody}>
            <ManagerMessageCard
              messageTheme={previewSent.message_theme}
              senderName={previewSenderName}
              body={previewSent.body}
              inboxKicker={t("managerMessage.inboxKicker")}
              isRTL={isRTL}
              previewLabel={t("managerMessage.sentPreviewTitle")}
            />
            <View style={[styles.previewModalMeta, isRTL && styles.sentMetaRtl]}>
              <AppText variant="caption" soft isRTL={isRTL}>
                {t("managerMessage.sentAt").replace("{when}", formatSentWhen(previewSent.created_at, language))}
              </AppText>
              {previewSent.read_at ? (
                <AppText variant="caption" soft isRTL={isRTL}>
                  {t("managerMessage.readAt").replace("{when}", formatSentWhen(previewSent.read_at, language))}
                </AppText>
              ) : null}
            </View>
            <ActionButton label={t("common.close")} onPress={() => setPreviewSent(null)} />
          </View>
        ) : null}
      </AppModal>

      <View style={styles.composeCard}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("managerMessage.composeTitle")}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.cardHint}>
          {step === "pick" ? t("managerMessage.pickStepHint") : t("managerMessage.composeStepHint")}
        </AppText>

        {step === "pick" ? (
          <>
            <AppTextField
              isRTL={isRTL}
              value={search}
              onChangeText={setSearch}
              placeholder={t("managerMessage.searchUser")}
              variant="dark"
              containerStyle={styles.field}
            />
            {searching ? (
              <ActivityIndicator color={theme.colors.cta} style={styles.spinner} />
            ) : search.trim().length === 0 ? (
              <View style={styles.emptyPick}>
                <AppText variant="caption" muted isRTL={isRTL} style={styles.emptyPickTxt}>
                  {t("managerMessage.searchHint")}
                </AppText>
              </View>
            ) : hits.length === 0 ? (
              <View style={styles.emptyPick}>
                <AppText variant="caption" muted isRTL={isRTL}>
                  {t("managerMessage.noUsersFound")}
                </AppText>
              </View>
            ) : (
              <ScrollView
                style={styles.hitScroll}
                contentContainerStyle={styles.hitScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                {hits.map((h) => (
                  <Pressable
                    key={h.user_id}
                    onPress={() => pickUser(h)}
                    style={({ pressed }) => [styles.hitRow, isRTL && styles.hitRowRtl, pressed && styles.hitRowPressed]}
                  >
                    <View style={styles.hitAvatar}>
                      <AppText variant="caption" style={styles.hitAvatarTxt}>
                        {initialsFromName(h.full_name)}
                      </AppText>
                    </View>
                    <View style={[styles.hitBody, isRTL && styles.hitBodyRtl]}>
                      <AppText variant="body" isRTL={isRTL} numberOfLines={1}>
                        {h.full_name}
                      </AppText>
                      <AppText variant="caption" muted numberOfLines={1}>
                        {h.username ? `@${h.username}` : h.role}
                      </AppText>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </>
        ) : selected ? (
          <>
            <View style={[styles.selectedRow, isRTL && styles.selectedRowRtl]}>
              <View style={styles.selectedAvatar}>
                <AppText variant="caption" style={styles.hitAvatarTxt}>
                  {initialsFromName(selected.full_name)}
                </AppText>
              </View>
              <View style={[styles.selectedMeta, isRTL && styles.selectedMetaRtl]}>
                <AppText variant="body" isRTL={isRTL} style={styles.selectedName}>
                  {selected.full_name}
                </AppText>
                <AppText variant="caption" muted isRTL={isRTL}>
                  {selected.username ? `@${selected.username}` : selected.role}
                </AppText>
              </View>
            </View>

            <AppText variant="label" muted isRTL={isRTL} style={styles.themeLabel}>
              {t("managerMessage.themeLabel")}
            </AppText>
            <View style={[styles.themeRow, isRTL && styles.themeRowRtl]}>
              {MANAGER_MESSAGE_THEMES.map((key) => {
                const active = messageTheme === key;
                const palette = getManagerMessageThemeStyle(key);
                return (
                  <Pressable
                    key={key}
                    onPress={() => setMessageTheme(key)}
                    style={({ pressed }) => [
                      styles.themeChip,
                      active && { borderColor: palette.avatarBg, backgroundColor: palette.bubbleBg },
                      pressed && { opacity: 0.9 },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <AppText variant="body" style={styles.themeEmoji}>
                      {palette.emoji}
                    </AppText>
                    <AppText
                      variant="caption"
                      style={[styles.themeChipTxt, active && { color: palette.bubbleText, fontWeight: "800" }]}
                    >
                      {t(managerMessageThemeLabelKey(key))}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>

            <AppTextField
              isRTL={isRTL}
              value={body}
              onChangeText={(v) => {
                setBody(v);
                setError(null);
              }}
              placeholder={t("managerMessage.messagePlaceholder")}
              multiline
              variant="dark"
              containerStyle={styles.field}
              style={styles.messageInput}
            />

            <View style={styles.previewShell}>
              <ManagerMessageCard
                messageTheme={messageTheme}
                senderName={previewSenderName}
                body={body}
                inboxKicker={t("managerMessage.inboxKicker")}
                isRTL={isRTL}
                previewLabel={t("managerMessage.livePreview")}
              />
            </View>

            {error ? (
              <AppText isRTL={isRTL} style={styles.error}>
                {error}
              </AppText>
            ) : null}

            <PrimaryButton
              label={sending ? t("common.loading") : t("managerMessage.send")}
              onPress={() => void onSend()}
              disabled={!canSend}
              loading={sending}
              loadingLabel={t("common.loading")}
            />
            <ActionButton label={t("managerMessage.changeRecipient")} onPress={backToPick} />
          </>
        ) : null}
      </View>

      <View style={styles.sentCard}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("managerMessage.sentTitle")}
        </AppText>
        <CrossfadeSwap
          loading={loadingSent}
          skeleton={<ActivityIndicator color={theme.colors.cta} style={styles.spinner} />}
        >
        {sent.length === 0 ? (
          <AppText variant="caption" muted isRTL={isRTL} style={styles.emptySent}>
            {t("managerMessage.sentEmpty")}
          </AppText>
        ) : (
          <View style={styles.sentList}>
            {sent.map((row, index) => {
              const read = !!row.read_at;
              return (
                <FadeSlideIn key={row.id} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
                <View style={[styles.sentRow, isRTL && styles.sentRowRtl]}>
                  <Pressable
                    onPress={() => setPreviewSent(row)}
                    style={({ pressed }) => [styles.sentRowMain, isRTL && styles.sentRowRtl, pressed && styles.sentRowPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t("managerMessage.sentPreviewTitle")}
                  >
                    <View style={styles.sentAvatar}>
                      <AppText variant="caption" style={styles.sentAvatarTxt}>
                        {initialsFromName(row.recipient_name)}
                      </AppText>
                    </View>
                    <View style={[styles.sentBody, isRTL && styles.sentBodyRtl]}>
                      <View style={[styles.sentTop, isRTL && styles.sentTopRtl]}>
                        <AppText variant="body" isRTL={isRTL} numberOfLines={1} style={styles.sentName}>
                          {getManagerMessageThemeStyle(row.message_theme).emoji} {row.recipient_name}
                        </AppText>
                        <View style={[styles.statusPill, read ? styles.statusRead : styles.statusPending]}>
                          <AppText variant="caption" style={read ? styles.statusReadTxt : styles.statusPendingTxt}>
                            {read ? t("managerMessage.statusRead") : t("managerMessage.statusPending")}
                          </AppText>
                        </View>
                      </View>
                      <AppText variant="caption" muted isRTL={isRTL} numberOfLines={2}>
                        {row.body}
                      </AppText>
                      <View style={[styles.sentMeta, isRTL && styles.sentMetaRtl]}>
                        <AppText variant="caption" soft isRTL={isRTL}>
                          {t("managerMessage.sentAt").replace("{when}", formatSentWhen(row.created_at, language))}
                        </AppText>
                        {read && row.read_at ? (
                          <AppText variant="caption" soft isRTL={isRTL} style={styles.readAt}>
                            {t("managerMessage.readAt").replace("{when}", formatSentWhen(row.read_at, language))}
                          </AppText>
                        ) : null}
                      </View>
                    </View>
                  </Pressable>
                  {!read ? (
                    <Pressable
                      onPress={() => confirmCancel(row)}
                      disabled={cancellingId === row.id}
                      style={({ pressed }) => [
                        styles.cancelBtn,
                        isRTL && styles.cancelBtnRtl,
                        pressed && { opacity: 0.85 },
                        cancellingId === row.id && { opacity: 0.5 },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={t("managerMessage.cancelAction")}
                    >
                      <AppText variant="caption" style={styles.cancelBtnTxt}>
                        {cancellingId === row.id ? t("common.loading") : t("managerMessage.cancelAction")}
                      </AppText>
                    </Pressable>
                  ) : null}
                </View>
                </FadeSlideIn>
              );
            })}
          </View>
        )}
        </CrossfadeSwap>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: theme.spacing.lg },
  composeCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  sentCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  cardTitle: { fontWeight: "900", marginBottom: theme.spacing.xs },
  cardHint: { marginBottom: theme.spacing.md },
  field: { marginBottom: theme.spacing.sm },
  spinner: { marginVertical: theme.spacing.md },
  emptyPick: {
    paddingVertical: theme.spacing.lg,
    paddingHorizontal: theme.spacing.sm,
    alignItems: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  emptyPickTxt: { textAlign: "center" },
  hitScroll: { maxHeight: 280 },
  hitScrollContent: { gap: 8, paddingBottom: 4 },
  hitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  hitRowRtl: { flexDirection: "row-reverse" },
  hitRowPressed: { opacity: 0.88 },
  hitAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#7c6cf0",
    alignItems: "center",
    justifyContent: "center",
  },
  hitAvatarTxt: { color: "#fff", fontWeight: "800" },
  hitBody: { flex: 1, minWidth: 0 },
  hitBodyRtl: { alignItems: "flex-end" },
  selectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.infoBg,
    borderWidth: 1,
    borderColor: theme.colors.infoBorder,
  },
  selectedRowRtl: { flexDirection: "row-reverse" },
  selectedAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#7c6cf0",
    alignItems: "center",
    justifyContent: "center",
  },
  selectedMeta: { flex: 1, minWidth: 0 },
  selectedMetaRtl: { alignItems: "flex-end" },
  selectedName: { fontWeight: "800" },
  themeLabel: { marginTop: theme.spacing.sm, marginBottom: theme.spacing.xs, textTransform: "uppercase" },
  themeRow: { flexDirection: "row", gap: 8, marginBottom: theme.spacing.md },
  themeRowRtl: { flexDirection: "row-reverse" },
  themeChip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.backgroundAlt,
    gap: 2,
  },
  themeEmoji: { fontSize: 18, lineHeight: 22 },
  themeChipTxt: { color: theme.colors.textMuted, fontWeight: "700" },
  previewShell: {
    marginBottom: theme.spacing.md,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: "rgba(8, 8, 12, 0.55)",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  messageInput: { minHeight: 120, textAlignVertical: "top" },
  error: { color: theme.colors.error, fontWeight: "600", marginBottom: theme.spacing.sm },
  emptySent: { marginTop: theme.spacing.sm },
  sentList: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  sentRow: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  sentRowMain: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
  },
  sentRowPressed: { opacity: 0.88 },
  sentRowRtl: { flexDirection: "row-reverse" },
  sentAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  sentAvatarTxt: { fontWeight: "800", color: theme.colors.textMuted },
  sentBody: { flex: 1, minWidth: 0, gap: 4 },
  sentBodyRtl: { alignItems: "flex-end" },
  sentTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  sentTopRtl: { flexDirection: "row-reverse" },
  sentName: { flex: 1, fontWeight: "800" },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
  },
  statusPending: {
    backgroundColor: theme.colors.warningBg,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
  },
  statusRead: {
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.35)",
  },
  statusPendingTxt: { color: theme.colors.warning, fontWeight: "800", fontSize: 11 },
  statusReadTxt: { color: theme.colors.success, fontWeight: "800", fontSize: 11 },
  sentMeta: { marginTop: 4, gap: 2 },
  sentMetaRtl: { alignItems: "flex-end" },
  readAt: {},
  cancelBtn: {
    alignSelf: "flex-start",
    marginTop: 0,
    marginHorizontal: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
  },
  cancelBtnRtl: { alignSelf: "flex-end" },
  cancelBtnTxt: { color: theme.colors.error, fontWeight: "800" },
  previewModalBackdrop: { backgroundColor: "rgba(8, 8, 12, 0.72)" },
  previewModalCard: {
    backgroundColor: "transparent",
    borderWidth: 0,
    padding: 0,
    maxWidth: 420,
    width: "100%",
  },
  previewModalBody: { gap: theme.spacing.md, width: "100%" },
  previewModalMeta: { gap: 4, paddingHorizontal: theme.spacing.xs },
});
