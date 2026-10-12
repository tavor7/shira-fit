import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useDiscardChangesPrompt } from "../hooks/useDiscardChangesPrompt";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { supabase } from "../lib/supabase";
import { rowFlipFor } from "../lib/layoutDirection";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import {
  rpcCopySubscriptionTermsVersionToDraft,
  rpcGetSubscriptionTermsAdmin,
  rpcPublishSubscriptionTermsDraft,
  rpcSaveSubscriptionTermsDraft,
  rpcSetSubscriptionTermsEnforced,
  subscriptionTermsProblemKey,
  subscriptionTermsTextProblems,
  type SubscriptionTermsAdmin,
  type SubscriptionTermsDocument,
} from "../lib/subscriptionTerms";
import { AppText } from "../components/AppText";
import { AppSwitch } from "../components/AppSwitch";
import { AppModal } from "../components/AppModal";
import { AppTextField } from "../components/AppTextField";
import { PrimaryButton } from "../components/PrimaryButton";
import { SegmentedChoice } from "../components/SegmentedChoice";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { SubscriptionTermsDocumentView } from "../components/subscriptions/SubscriptionTermsDocumentView";

type DraftFields = { title: string; title_en: string; body_text: string; body_text_en: string };
const EMPTY: DraftFields = { title: "", title_en: "", body_text: "", body_text_en: "" };
type PreviewDoc = { doc: Pick<SubscriptionTermsDocument, "title" | "title_en" | "body_text" | "body_text_en">; version: string };

/**
 * Setup -> Legal -> Subscription terms. Managers turn mandatory acceptance on/off, read the published version, edit a
 * draft (never visible to athletes), preview it exactly as athletes will see it, publish it as a new immutable version
 * (choosing whether athletes who accepted an earlier version must accept again) and restore an earlier version as a new
 * draft. Every action is manager-only on the server.
 */
export default function ManagerSubscriptionTermsScreen() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const [admin, setAdmin] = useState<SubscriptionTermsAdmin | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fields, setFields] = useState<DraftFields>(EMPTY);
  const [saved, setSaved] = useState<DraftFields>(EMPTY);
  const [busy, setBusy] = useState<"" | "toggle" | "save" | "publish" | "copy">("");
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const [previewLang, setPreviewLang] = useState<"he" | "en">(language);
  const [publishOpen, setPublishOpen] = useState(false);
  const [requireReconsent, setRequireReconsent] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await rpcGetSubscriptionTermsAdmin(supabase);
      if (!res.ok) throw new Error(res.error);
      setAdmin(res);
      const d = res.draft ? { title: res.draft.title, title_en: res.draft.title_en, body_text: res.draft.body_text, body_text_en: res.draft.body_text_en } : EMPTY;
      setFields(d);
      setSaved(d);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const current = admin?.versions.find((v) => v.is_current) ?? null;
  const draft = admin?.draft ?? null;
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const problems = useMemo(() => subscriptionTermsTextProblems(fields), [fields]);

  // Unsaved draft edits: confirm before leaving.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("subscriptionTermsAdmin.unsavedTitle"),
        t("subscriptionTermsAdmin.unsavedBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          dirtyRef.current = false;
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t, promptDiscardChanges]);

  function toggleEnforced(next: boolean) {
    if (!admin || busy) return;
    showConfirm({
      title: t(next ? "managerSubscriptionTerms.enableTitle" : "managerSubscriptionTerms.disableTitle"),
      message: t(next ? "managerSubscriptionTerms.enableBody" : "managerSubscriptionTerms.disableBody").replace("{v}", String(current?.version ?? "")),
      cancelLabel: t("common.cancel"),
      confirmLabel: t(next ? "managerSubscriptionTerms.enableConfirm" : "managerSubscriptionTerms.disableConfirm"),
      confirmVariant: next ? "primary" : "danger",
      onConfirm: () =>
        void (async () => {
          setBusy("toggle");
          const res = await rpcSetSubscriptionTermsEnforced(supabase, next);
          setBusy("");
          showToast({ message: t(res.ok ? "common.saved" : "common.failed"), variant: res.ok ? "success" : "error" });
          await load();
        })(),
    });
  }

  async function startFromVersion(version: number) {
    const go = async () => {
      setBusy("copy");
      const res = await rpcCopySubscriptionTermsVersionToDraft(supabase, version);
      setBusy("");
      if (!res.ok) showToast({ message: t("common.failed"), variant: "error" });
      await load();
    };
    if (draft || dirty) {
      showConfirm({
        title: t("subscriptionTermsAdmin.replaceDraftTitle"),
        message: t("subscriptionTermsAdmin.replaceDraftBody").replace("{v}", String(version)),
        cancelLabel: t("common.cancel"),
        confirmLabel: t("subscriptionTermsAdmin.replaceDraftConfirm"),
        confirmVariant: "danger",
        onConfirm: () => void go(),
      });
      return;
    }
    await go();
  }

  async function saveDraft() {
    if (busy) return;
    setBusy("save");
    const res = await rpcSaveSubscriptionTermsDraft(supabase, { ...fields, based_on_version: draft?.based_on_version ?? current?.version ?? null });
    setBusy("");
    if (!res.ok) {
      showToast({ message: t(res.error === "too_long" ? "subscriptionTermsAdmin.tooLong" : "common.failed"), variant: "error" });
      return;
    }
    showToast({ message: t("subscriptionTermsAdmin.draftSaved"), variant: "success" });
    await load();
  }

  async function publish() {
    if (!draft || busy) return;
    setBusy("publish");
    const res = await rpcPublishSubscriptionTermsDraft(supabase, requireReconsent, draft.updated_at);
    setBusy("");
    setPublishOpen(false);
    if (!res.ok) {
      const key =
        res.error === "incomplete"
          ? "subscriptionTermsAdmin.incomplete"
          : res.error === "draft_changed"
            ? "subscriptionTermsAdmin.draftChanged"
            : "common.failed";
      showToast({ message: t(key), variant: "error" });
      await load();
      return;
    }
    showToast({ message: t("subscriptionTermsAdmin.published").replace("{v}", String(res.version)), variant: "success" });
    setRequireReconsent(false);
    await load();
  }

  if (loading) {
    return (
      <View style={[styles.root, screenContent]}>
        <Skeleton height={160} style={styles.skeleton} />
      </View>
    );
  }
  if (loadFailed || !admin) {
    return (
      <View style={styles.root}>
        <EmptyState tone="error" title={t("subscriptionTermsAdmin.loadError")} actionLabel={t("subscriptions.retry")} onAction={() => void load()} isRTL={isRTL} />
      </View>
    );
  }

  const c = admin.counts;
  const editing = !!draft || dirty;
  const canPublish = !!draft && !dirty && problems.length === 0;

  return (
    <>
      <ScrollView style={styles.root} contentContainerStyle={[styles.container, screenContent]} keyboardShouldPersistTaps="handled">
        {/* 1. Enforcement */}
        <View style={styles.card}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("managerSubscriptionTerms.title")}
          </AppText>
          <AppText variant="body" isRTL={isRTL} style={styles.status}>
            {t(admin.enforced ? "managerSubscriptionTerms.statusOn" : "managerSubscriptionTerms.statusOff")}
          </AppText>
          {!admin.enforced ? (
            <View style={styles.notice}>
              <AppText variant="caption" isRTL={isRTL} style={styles.noticeTxt}>
                {t("managerSubscriptionTerms.approvalNotice")}
              </AppText>
            </View>
          ) : null}
          <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.rowRtl]}>
            <AppText variant="body" isRTL={isRTL} style={styles.flex}>
              {t("managerSubscriptionTerms.switchLabel")}
            </AppText>
            <AppSwitch
              value={admin.enforced}
              onValueChange={toggleEnforced}
              onColor={theme.colors.success}
              accessibilityLabel={t("managerSubscriptionTerms.switchLabel")}
              disabled={!!busy || !current}
            />
          </View>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("managerSubscriptionTerms.scope")}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("managerSubscriptionTerms.counts")
              .replace("{accepted}", String(c.accepted ?? 0))
              .replace("{pending}", String(c.pending ?? 0))
              .replace("{notRequired}", String(c.not_required ?? 0))}
          </AppText>
        </View>

        {/* 2. Published version */}
        <View style={styles.card}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("subscriptionTermsAdmin.publishedTitle")}
          </AppText>
          {current ? (
            <>
              <AppText variant="body" isRTL={isRTL} style={styles.status}>
                {t("subscriptionTermsAdmin.versionLine")
                  .replace("{v}", String(current.version))
                  .replace("{date}", current.effective_at ? formatDateTimeForDisplay(current.effective_at, language) : "—")}
              </AppText>
              <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
                {t(current.requires_reconsent ? "subscriptionTermsAdmin.reconsentYes" : "subscriptionTermsAdmin.reconsentNo")}
                {" · "}
                {t("subscriptionTermsAdmin.acceptedCount").replace("{n}", String(current.accepted_count))}
              </AppText>
              <View style={[styles.actions, rowFlipFor(isRTL) && styles.rowRtl]}>
                <PrimaryButton
                  variant="ghost"
                  label={t("subscriptionTermsAdmin.preview")}
                  onPress={() => setPreview({ doc: current, version: String(current.version) })}
                  style={styles.flex}
                />
                {!editing ? (
                  <PrimaryButton
                    label={t("subscriptionTermsAdmin.editAsDraft")}
                    onPress={() => void startFromVersion(current.version)}
                    loading={busy === "copy"}
                    style={styles.flex}
                  />
                ) : null}
              </View>
            </>
          ) : (
            <AppText variant="caption" muted isRTL={isRTL}>
              {t("managerSubscriptionTerms.noDocument")}
            </AppText>
          )}
        </View>

        {/* 3. Draft editor */}
        {editing ? (
          <View style={styles.card}>
            <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
              {t("subscriptionTermsAdmin.draftTitle")}
            </AppText>
            <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
              {t("subscriptionTermsAdmin.draftHint")}
              {draft?.based_on_version ? " " + t("subscriptionTermsAdmin.basedOn").replace("{v}", String(draft.based_on_version)) : ""}
            </AppText>

            <AppText variant="label" isRTL={isRTL} style={styles.langHeading}>
              {t("subscriptionTermsAdmin.hebrewHeading")}
            </AppText>
            <AppTextField
              label={t("subscriptionTermsAdmin.titleLabel")}
              value={fields.title}
              onChangeText={(v) => setFields((f) => ({ ...f, title: v }))}
              variant="dark"
              isRTL
              style={styles.rtlInput}
              containerStyle={styles.field}
            />
            <AppTextField
              label={t("subscriptionTermsAdmin.bodyLabel")}
              value={fields.body_text}
              onChangeText={(v) => setFields((f) => ({ ...f, body_text: v }))}
              multiline
              variant="dark"
              isRTL
              style={[styles.bodyInput, styles.rtlInput]}
              containerStyle={styles.field}
            />

            <AppText variant="label" isRTL={isRTL} style={styles.langHeading}>
              {t("subscriptionTermsAdmin.englishHeading")}
            </AppText>
            <AppTextField
              label={t("subscriptionTermsAdmin.titleLabel")}
              value={fields.title_en}
              onChangeText={(v) => setFields((f) => ({ ...f, title_en: v }))}
              variant="dark"
              isRTL={false}
              style={styles.ltrInput}
              containerStyle={styles.field}
            />
            <AppTextField
              label={t("subscriptionTermsAdmin.bodyLabel")}
              value={fields.body_text_en}
              onChangeText={(v) => setFields((f) => ({ ...f, body_text_en: v }))}
              multiline
              variant="dark"
              isRTL={false}
              style={[styles.bodyInput, styles.ltrInput]}
              containerStyle={styles.field}
            />

            {problems.length > 0 ? (
              <View style={styles.problems} accessibilityLiveRegion="polite">
                {problems.map((p) => (
                  <AppText key={p} variant="caption" isRTL={isRTL} style={styles.problemTxt}>
                    • {t(subscriptionTermsProblemKey(p))}
                  </AppText>
                ))}
              </View>
            ) : null}
            {dirty ? (
              <AppText variant="caption" isRTL={isRTL} style={styles.unsaved}>
                {t("subscriptionTermsAdmin.unsavedNote")}
              </AppText>
            ) : null}

            <View style={[styles.actions, rowFlipFor(isRTL) && styles.rowRtl]}>
              <PrimaryButton
                variant="ghost"
                label={t("subscriptionTermsAdmin.previewDraft")}
                onPress={() => setPreview({ doc: fields, version: t("subscriptionTermsAdmin.draftVersionLabel") })}
                style={styles.flex}
              />
              <PrimaryButton
                variant="ghost"
                label={t("subscriptionTermsAdmin.saveDraft")}
                onPress={() => void saveDraft()}
                loading={busy === "save"}
                disabled={!dirty}
                style={styles.flex}
              />
            </View>
            <PrimaryButton
              label={t("subscriptionTermsAdmin.publish")}
              onPress={() => setPublishOpen(true)}
              disabled={!canPublish || !!busy}
            />
            {!canPublish ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
                {t(dirty ? "subscriptionTermsAdmin.saveBeforePublish" : "subscriptionTermsAdmin.completeBeforePublish")}
              </AppText>
            ) : null}
          </View>
        ) : null}

        {/* 4. History */}
        <View style={styles.card}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("subscriptionTermsAdmin.historyTitle")}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
            {t("subscriptionTermsAdmin.historyHint")}
          </AppText>
          {admin.versions.map((v) => (
            <View key={v.version} style={styles.historyRow}>
              <View style={[styles.historyHead, rowFlipFor(isRTL) && styles.rowRtl]}>
                <AppText variant="body" isRTL={isRTL} style={[styles.flex, styles.historyTitle]}>
                  {t("subscriptionTerms.version").replace("{v}", String(v.version))}
                  {v.is_current ? ` · ${t("managerLegal.current")}` : ""}
                </AppText>
                <AppText variant="caption" muted>
                  {v.effective_at ? formatDateTimeForDisplay(v.effective_at, language) : ""}
                </AppText>
              </View>
              <AppText variant="caption" muted isRTL={isRTL}>
                {t(v.requires_reconsent ? "subscriptionTermsAdmin.reconsentYes" : "subscriptionTermsAdmin.reconsentNo")}
                {" · "}
                {t("subscriptionTermsAdmin.acceptedCount").replace("{n}", String(v.accepted_count))}
              </AppText>
              <View style={[styles.historyActions, rowFlipFor(isRTL) && styles.rowRtl]}>
                <Pressable
                  onPress={() => setPreview({ doc: v, version: String(v.version) })}
                  style={({ pressed }) => [styles.link, pressed && { opacity: 0.8 }]}
                  accessibilityRole="button"
                >
                  <AppText variant="label" style={styles.linkTxt}>
                    {t("subscriptionTermsAdmin.view")}
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={() => void startFromVersion(v.version)}
                  disabled={!!busy}
                  style={({ pressed }) => [styles.link, pressed && { opacity: 0.8 }]}
                  accessibilityRole="button"
                >
                  <AppText variant="label" style={styles.linkTxt}>
                    {t("subscriptionTermsAdmin.restore")}
                  </AppText>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Preview exactly as athletes see it */}
      <AppModal
        visible={!!preview}
        onClose={() => setPreview(null)}
        variant="dialog"
        backdropAccessibilityLabel={t("common.close")}
        maxHeightPct={0.92}
        cardStyle={styles.previewCard}
      >
        {preview ? (
          <SubscriptionTermsDocumentView
            title={(previewLang === "en" ? preview.doc.title_en : preview.doc.title) || preview.doc.title}
            body={(previewLang === "en" ? preview.doc.body_text_en : preview.doc.body_text) || ""}
            version={preview.version}
            isRTL={previewLang === "he"}
            t={t}
            checked={false}
            onToggle={() => undefined}
            onAccept={() => undefined}
            previewOnly
            header={
              <View style={styles.previewHeader}>
                <View style={styles.previewBanner}>
                  <AppText variant="caption" isRTL={isRTL} style={styles.previewBannerTxt}>
                    {t("subscriptionTermsAdmin.previewBanner")}
                  </AppText>
                </View>
                <SegmentedChoice<"he" | "en">
                  options={[
                    { value: "he", label: "עברית" },
                    { value: "en", label: "English" },
                  ]}
                  value={previewLang}
                  onChange={setPreviewLang}
                  isRTL={isRTL}
                  accessibilityLabel={t("subscriptionTermsAdmin.previewLanguage")}
                />
              </View>
            }
          />
        ) : null}
        <Pressable onPress={() => setPreview(null)} style={({ pressed }) => [styles.close, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <AppText variant="label" style={styles.closeTxt}>
            {t("common.close")}
          </AppText>
        </Pressable>
      </AppModal>

      {/* Publish confirmation with the renewed-acceptance choice */}
      <AppModal
        visible={publishOpen}
        onClose={() => (busy ? null : setPublishOpen(false))}
        variant="dialog"
        backdropAccessibilityLabel={t("common.cancel")}
        cardStyle={styles.publishCard}
      >
        <AppText variant="title" isRTL={isRTL} accessibilityRole="header" style={styles.cardTitle}>
          {t("subscriptionTermsAdmin.publishTitle").replace("{v}", String((admin.versions[0]?.version ?? 0) + 1))}
        </AppText>
        <AppText variant="body" isRTL={isRTL} style={styles.status}>
          {t("subscriptionTermsAdmin.publishBody")}
        </AppText>
        <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.rowRtl]}>
          <AppText variant="body" isRTL={isRTL} style={styles.flex}>
            {t("subscriptionTermsAdmin.requireReconsent")}
          </AppText>
          <AppSwitch value={requireReconsent} onValueChange={setRequireReconsent} accessibilityLabel={t("subscriptionTermsAdmin.requireReconsent")} />
        </View>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
          {t(requireReconsent ? "subscriptionTermsAdmin.reconsentOnHint" : "subscriptionTermsAdmin.reconsentOffHint")}
        </AppText>
        <View style={styles.publishActions}>
          <PrimaryButton label={t("subscriptionTermsAdmin.publishConfirm")} onPress={() => void publish()} loading={busy === "publish"} />
          <Pressable onPress={() => setPublishOpen(false)} disabled={!!busy} style={({ pressed }) => [styles.close, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <AppText variant="label" style={styles.closeTxt}>
              {t("common.cancel")}
            </AppText>
          </Pressable>
        </View>
      </AppModal>
      {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { padding: theme.spacing.md, gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
  skeleton: { margin: theme.spacing.md, borderRadius: theme.radius.lg },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  cardTitle: { marginBottom: theme.spacing.xs },
  status: { marginBottom: theme.spacing.sm, lineHeight: 21 },
  notice: { backgroundColor: theme.colors.warningBg, borderRadius: theme.radius.md, padding: theme.spacing.sm, marginBottom: theme.spacing.sm },
  noticeTxt: { color: theme.colors.text, lineHeight: 18 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm, minHeight: 44 },
  rowRtl: { flexDirection: "row-reverse" },
  flex: { flex: 1 },
  meta: { marginTop: theme.spacing.xs, lineHeight: 18 },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm },
  langHeading: { marginTop: theme.spacing.md, marginBottom: theme.spacing.xs, color: theme.colors.text },
  field: { marginBottom: theme.spacing.sm },
  bodyInput: { minHeight: 220, textAlignVertical: "top" },
  rtlInput: { textAlign: "right", writingDirection: "rtl" },
  ltrInput: { textAlign: "left", writingDirection: "ltr" },
  problems: { backgroundColor: theme.colors.warningBg, borderRadius: theme.radius.md, padding: theme.spacing.sm, gap: 2, marginTop: theme.spacing.xs },
  problemTxt: { color: theme.colors.text },
  unsaved: { marginTop: theme.spacing.xs, color: theme.colors.text, fontWeight: "700" },
  historyRow: { paddingVertical: theme.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.borderMuted, gap: 2 },
  historyHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  historyTitle: { fontWeight: "800" },
  historyActions: { flexDirection: "row", gap: theme.spacing.md },
  link: { minHeight: 44, justifyContent: "center" },
  linkTxt: { color: theme.colors.cta, fontWeight: "800" },
  previewCard: { padding: theme.spacing.lg, maxWidth: 560 },
  previewHeader: { gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  previewBanner: { backgroundColor: theme.colors.infoBg, borderRadius: theme.radius.md, padding: theme.spacing.sm },
  previewBannerTxt: { color: theme.colors.text, fontWeight: "700" },
  close: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: theme.spacing.xs },
  closeTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  publishCard: { padding: theme.spacing.lg, maxWidth: 520 },
  publishActions: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
});
