import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { AppText } from "./AppText";
import { AppTextField } from "./AppTextField";
import { PrimaryButton } from "./PrimaryButton";
import { ActionButton } from "./ActionButton";
import {
  cancelManagerDirectMessage,
  fetchSentManagerDirectMessages,
  initialsFromName,
  searchMessageRecipients,
  sendManagerDirectMessage,
  type MessageRecipient,
  type SentManagerMessage,
} from "../lib/managerDirectMessages";
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
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const [step, setStep] = useState<Step>("pick");
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
    setError(null);
  }

  async function onSend() {
    if (!selected || !canSend) return;
    setError(null);
    setSending(true);
    const res = await sendManagerDirectMessage(selected.user_id, body);
    setSending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast({ message: t("managerMessage.sentOk"), variant: "success" });
    setBody("");
    setSelected(null);
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
        {loadingSent ? (
          <ActivityIndicator color={theme.colors.cta} style={styles.spinner} />
        ) : sent.length === 0 ? (
          <AppText variant="caption" muted isRTL={isRTL} style={styles.emptySent}>
            {t("managerMessage.sentEmpty")}
          </AppText>
        ) : (
          <View style={styles.sentList}>
            {sent.map((row) => {
              const read = !!row.read_at;
              return (
                <View key={row.id} style={[styles.sentRow, isRTL && styles.sentRowRtl]}>
                  <View style={styles.sentAvatar}>
                    <AppText variant="caption" style={styles.sentAvatarTxt}>
                      {initialsFromName(row.recipient_name)}
                    </AppText>
                  </View>
                  <View style={[styles.sentBody, isRTL && styles.sentBodyRtl]}>
                    <View style={[styles.sentTop, isRTL && styles.sentTopRtl]}>
                      <AppText variant="body" isRTL={isRTL} numberOfLines={1} style={styles.sentName}>
                        {row.recipient_name}
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
                </View>
              );
            })}
          </View>
        )}
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
  messageInput: { minHeight: 120, textAlignVertical: "top" },
  error: { color: theme.colors.error, fontWeight: "600", marginBottom: theme.spacing.sm },
  emptySent: { marginTop: theme.spacing.sm },
  sentList: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  sentRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
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
    marginTop: theme.spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    backgroundColor: theme.colors.errorBg,
  },
  cancelBtnRtl: { alignSelf: "flex-end" },
  cancelBtnTxt: { color: theme.colors.error, fontWeight: "800" },
});
