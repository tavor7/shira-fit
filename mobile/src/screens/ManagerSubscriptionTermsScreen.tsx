import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFocusEffect } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { theme } from "../theme";
import { translatorFor, useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useDiscardChangesPrompt } from "../hooks/useDiscardChangesPrompt";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { supabase } from "../lib/supabase";
import { rowFlipFor } from "../lib/layoutDirection";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import {
  rpcDiscardSubscriptionTermsDraft,
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
import { AppIcon } from "../components/AppIcon";
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
type PreviewDoc = { doc: Pick<SubscriptionTermsDocument, "title" | "title_en" | "body_text" | "body_text_en">; version: number | null };
type Lang = "he" | "en";

const sameFields = (a: DraftFields, b: DraftFields) =>
  a.title === b.title && a.title_en === b.title_en && a.body_text === b.body_text && a.body_text_en === b.body_text_en;
const fieldsOf = (d: { title: string; title_en: string | null; body_text: string; body_text_en: string | null }): DraftFields => ({ title: d.title, title_en: d.title_en ?? "", body_text: d.body_text, body_text_en: d.body_text_en ?? "" });

/**
 * Setup -> Subscriptions -> Subscription terms. Managers turn mandatory acceptance on/off, read the published version, edit
 * a draft (never visible to athletes), preview it exactly as athletes will see it, publish it as a new immutable version
 * (choosing whether athletes who accepted an earlier version must accept again) and restore an earlier version. Every
 * action is manager-only on the server.
 *
 * Editing: "Edit" / "Restore" load a version's text into the editor locally - nothing is stored until "Save draft".
 * Cancel returns the editor to the last saved state (no draft, or the saved draft), asking first only when the manager
 * actually typed something since the edit started. With no unsaved changes, "Discard draft" deletes a saved draft.
 */
export default function ManagerSubscriptionTermsScreen() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { width: winW, height: winH } = useWindowDimensions();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const navigation = useNavigation();

  const [admin, setAdmin] = useState<SubscriptionTermsAdmin | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Editor contents. */
  const [fields, setFields] = useState<DraftFields>(EMPTY);
  /** Last saved draft (EMPTY when there is none). */
  const [saved, setSaved] = useState<DraftFields>(EMPTY);
  /** Contents when the current edit started (saved draft, or the version loaded by Edit / Restore). */
  const [baseline, setBaseline] = useState<DraftFields>(EMPTY);
  const [basedOn, setBasedOn] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "toggle" | "save" | "publish" | "discard">("");
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const [previewLang, setPreviewLang] = useState<Lang>(language);
  const [publishOpen, setPublishOpen] = useState(false);
  const [requireReconsent, setRequireReconsent] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await rpcGetSubscriptionTermsAdmin(supabase);
      if (!res.ok) throw new Error(res.error);
      setAdmin(res);
      const d = res.draft ? fieldsOf(res.draft) : EMPTY;
      setFields(d);
      setSaved(d);
      setBaseline(d);
      setBasedOn(res.draft?.based_on_version ?? null);
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
  /** Differs from the saved draft: Save is possible, Cancel is offered. */
  const dirty = !sameFields(fields, saved);
  /** The manager typed something since the edit started: confirm before throwing it away. */
  const hasEdits = !sameFields(fields, baseline);
  const problems = useMemo(() => subscriptionTermsTextProblems(fields), [fields]);

  // Typed changes: confirm before leaving the screen.
  const hasEditsRef = useRef(hasEdits);
  useEffect(() => {
    hasEditsRef.current = hasEdits;
  }, [hasEdits]);
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (!hasEditsRef.current) return;
      e.preventDefault();
      promptDiscardChanges(
        t("subscriptionTermsAdmin.unsavedTitle"),
        t("subscriptionTermsAdmin.unsavedBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          hasEditsRef.current = false;
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

  /** Load a published version's text into the editor (stored only when the manager saves the draft). */
  function startFromVersion(version: number) {
    const v = admin?.versions.find((x) => x.version === version);
    if (!v) return;
    const go = () => {
      const next = fieldsOf(v);
      setFields(next);
      setBaseline(next);
      setBasedOn(version);
    };
    if (draft || hasEdits) {
      showConfirm({
        title: t("subscriptionTermsAdmin.replaceDraftTitle"),
        message: t("subscriptionTermsAdmin.replaceDraftBody").replace("{v}", String(version)),
        cancelLabel: t("common.cancel"),
        confirmLabel: t("subscriptionTermsAdmin.replaceDraftConfirm"),
        confirmVariant: "danger",
        onConfirm: go,
      });
      return;
    }
    go();
  }

  function cancelEdit() {
    const revert = () => {
      setFields(saved);
      setBaseline(saved);
      setBasedOn(draft?.based_on_version ?? null);
    };
    if (!hasEdits) {
      revert();
      return;
    }
    promptDiscardChanges(
      t("subscriptionTermsAdmin.discardTitle"),
      t("subscriptionTermsAdmin.discardBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      revert
    );
  }

  /** Delete the saved draft (no unsaved changes): the editor closes and only the published version remains. */
  function discardDraft() {
    if (!draft || busy) return;
    showConfirm({
      title: t("subscriptionTermsAdmin.discardDraftTitle"),
      message: t("subscriptionTermsAdmin.discardDraftBody"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("subscriptionTermsAdmin.discardDraft"),
      confirmVariant: "danger",
      onConfirm: () =>
        void (async () => {
          setBusy("discard");
          const res = await rpcDiscardSubscriptionTermsDraft(supabase, draft.updated_at);
          setBusy("");
          showToast(
            res.ok
              ? { message: t("subscriptionTermsAdmin.draftDiscarded"), variant: "success" }
              : { message: t(res.error === "draft_changed" ? "subscriptionTermsAdmin.draftChangedReloaded" : "common.failed"), variant: "error" }
          );
          await load();
        })(),
    });
  }

  async function saveDraft() {
    if (busy) return;
    setBusy("save");
    const res = await rpcSaveSubscriptionTermsDraft(supabase, { ...fields, based_on_version: basedOn ?? current?.version ?? null });
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

  function openPreview(p: PreviewDoc) {
    setPreviewLang(language);
    setPreview(p);
  }

  if (loading) {
    return (
      <View style={[styles.root, styles.container, screenContent]}>
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

  // Preview: everything inside follows the preview language, so it is exactly what athletes using that language see.
  const tp = translatorFor(previewLang);
  const previewRTL = previewLang === "he";
  const narrow = winW < 600;
  const previewPad = narrow ? theme.spacing.sm : theme.spacing.lg;
  const previewWidth = Math.min(winW - previewPad * 2, 680);
  const previewHeight = Math.min(winH - previewPad * 2 - theme.spacing.lg * 2, 920);

  const langHeading = (key: string) => (
    <AppText variant="label" isRTL={isRTL} style={styles.langHeading}>
      {t(key)}
    </AppText>
  );

  return (
    <>
      <ScrollView style={styles.root} contentContainerStyle={[styles.container, screenContent]} keyboardShouldPersistTaps="handled">
        {/* 1. Mandatory acceptance */}
        <View style={styles.card}>
          <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.rowRtl]}>
            <AppText variant="body" isRTL={isRTL} style={[styles.flex, styles.switchLabel]}>
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
            {t("managerSubscriptionTerms.counts")
              .replace("{accepted}", String(c.accepted ?? 0))
              .replace("{pending}", String(c.pending ?? 0))
              .replace("{notRequired}", String(c.not_required ?? 0))}
          </AppText>
          {!admin.enforced ? (
            <View style={styles.notice}>
              <AppText variant="caption" isRTL={isRTL} style={styles.noticeTxt}>
                {t("managerSubscriptionTerms.approvalNotice")}
              </AppText>
            </View>
          ) : null}
        </View>

        {/* 2. Published version */}
        <View style={styles.card}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("subscriptionTermsAdmin.publishedTitle")}
          </AppText>
          {current ? (
            <>
              <AppText variant="body" isRTL={isRTL}>
                {t("subscriptionTermsAdmin.versionLine")
                  .replace("{v}", String(current.version))
                  .replace("{date}", current.effective_at ? formatDateTimeForDisplay(current.effective_at, language) : "—")}
              </AppText>
              <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
                {t("subscriptionTermsAdmin.acceptedCount").replace("{n}", String(current.accepted_count))}
              </AppText>
              <View style={[styles.actions, rowFlipFor(isRTL) && styles.rowRtl]}>
                <PrimaryButton
                  variant="ghost"
                  label={t("subscriptionTermsAdmin.preview")}
                  onPress={() => openPreview({ doc: current, version: current.version })}
                  style={styles.flex}
                />
                {!editing ? (
                  <PrimaryButton label={t("subscriptionTermsAdmin.edit")} onPress={() => startFromVersion(current.version)} style={styles.flex} />
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
            <AppText variant="title" isRTL={isRTL}>
              {t("subscriptionTermsAdmin.draftTitle")}
            </AppText>
            {basedOn ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
                {t("subscriptionTermsAdmin.basedOn").replace("{v}", String(basedOn))}
              </AppText>
            ) : null}

            {langHeading("subscriptionTermsAdmin.langHe")}
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

            {langHeading("subscriptionTermsAdmin.langEn")}
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

            <View style={[styles.actions, rowFlipFor(isRTL) && styles.rowRtl]}>
              <PrimaryButton
                variant="ghost"
                label={t("subscriptionTermsAdmin.preview")}
                onPress={() => openPreview({ doc: fields, version: null })}
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
            <PrimaryButton label={t("subscriptionTermsAdmin.publish")} onPress={() => setPublishOpen(true)} disabled={!canPublish || !!busy} />
            {dirty && problems.length === 0 ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.meta}>
                {t("subscriptionTermsAdmin.saveBeforePublish")}
              </AppText>
            ) : null}
            {/* Leave the editor: unsaved changes -> back to the last saved state; a saved draft -> delete it. */}
            {dirty || draft ? (
              <Pressable
                onPress={dirty ? cancelEdit : discardDraft}
                disabled={!!busy}
                style={({ pressed }) => [styles.close, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
              >
                <AppText variant="label" style={dirty ? styles.closeTxt : styles.discardTxt}>
                  {dirty ? t("common.cancel") : t("subscriptionTermsAdmin.discardDraft")}
                </AppText>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* 4. History */}
        <View style={styles.card}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("subscriptionTermsAdmin.historyTitle")}
          </AppText>
          {admin.versions.map((v, i) => (
            <View key={v.version} style={[styles.historyRow, i === admin.versions.length - 1 && styles.historyRowLast]}>
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
                {t("subscriptionTermsAdmin.acceptedCount").replace("{n}", String(v.accepted_count))}
                {v.requires_reconsent ? ` · ${t("subscriptionTermsAdmin.reconsentYes")}` : ""}
              </AppText>
              <View style={[styles.historyActions, rowFlipFor(isRTL) && styles.rowRtl]}>
                <Pressable
                  onPress={() => openPreview({ doc: v, version: v.version })}
                  style={({ pressed }) => [styles.link, pressed && { opacity: 0.8 }]}
                  accessibilityRole="button"
                >
                  <AppText variant="label" style={styles.linkTxt}>
                    {t("subscriptionTermsAdmin.view")}
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={() => startFromVersion(v.version)}
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
        backdropAccessibilityLabel={tp("common.close")}
        maxHeightPct={1}
        width={previewWidth}
        backdropStyle={{ padding: previewPad }}
        cardStyle={[styles.previewCard, narrow && styles.previewCardNarrow, { height: previewHeight, maxWidth: previewWidth }]}
      >
        {preview ? (
          <View style={styles.previewBody} {...(Platform.OS === "web" ? ({ dir: previewRTL ? "rtl" : "ltr", lang: previewLang } as object) : null)}>
            <SubscriptionTermsDocumentView
              title={(previewLang === "en" ? preview.doc.title_en : preview.doc.title) || preview.doc.title}
              body={(previewLang === "en" ? preview.doc.body_text_en : preview.doc.body_text) || ""}
              version={preview.version ?? ""}
              versionLabel={preview.version == null ? tp("subscriptionTermsAdmin.draftLabel") : undefined}
              isRTL={previewRTL}
              t={tp}
              checked={false}
              onToggle={() => undefined}
              onAccept={() => undefined}
              previewOnly
              fill
              header={
                // One compact row (preview label, language, close) so the terms text keeps most of the height.
                <View style={[styles.previewHeader, rowFlipFor(previewRTL) && styles.rowRtl]}>
                  <View style={styles.previewChip}>
                    <AppText variant="caption" style={styles.previewChipTxt} numberOfLines={1}>
                      {tp("subscriptionTermsAdmin.preview")}
                    </AppText>
                  </View>
                  <SegmentedChoice<Lang>
                    options={[
                      { value: "he", label: tp("subscriptionTermsAdmin.langHe") },
                      { value: "en", label: tp("subscriptionTermsAdmin.langEn") },
                    ]}
                    value={previewLang}
                    onChange={setPreviewLang}
                    isRTL={previewRTL}
                    accessibilityLabel={tp("subscriptionTermsAdmin.previewLanguage")}
                    style={styles.flex}
                  />
                  <Pressable
                    onPress={() => setPreview(null)}
                    style={({ pressed }) => [styles.previewClose, pressed && { opacity: 0.85 }]}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={tp("common.close")}
                  >
                    <AppIcon name="close" size="sm" color={theme.colors.textMuted} />
                  </Pressable>
                </View>
              }
            />
          </View>
        ) : null}
      </AppModal>

      {/* Publish confirmation with the renewed-acceptance choice */}
      <AppModal
        visible={publishOpen}
        onClose={() => (busy ? null : setPublishOpen(false))}
        variant="dialog"
        scrollContent
        backdropAccessibilityLabel={t("common.cancel")}
        cardStyle={styles.publishCard}
      >
        <AppText variant="title" isRTL={isRTL} accessibilityRole="header" style={styles.cardTitle}>
          {t("subscriptionTermsAdmin.publishTitle").replace("{v}", String((admin.versions[0]?.version ?? 0) + 1))}
        </AppText>
        <AppText variant="body" isRTL={isRTL} style={styles.publishBody}>
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
  skeleton: { borderRadius: theme.radius.lg },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
  },
  cardTitle: { marginBottom: theme.spacing.xs },
  notice: { backgroundColor: theme.colors.warningBg, borderRadius: theme.radius.md, padding: theme.spacing.sm, marginTop: theme.spacing.sm },
  noticeTxt: { color: theme.colors.text, lineHeight: 18 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.sm, minHeight: 44 },
  rowRtl: { flexDirection: "row-reverse" },
  flex: { flex: 1 },
  switchLabel: { fontWeight: "800" },
  meta: { marginTop: theme.spacing.xs, lineHeight: 18 },
  actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm },
  langHeading: { marginTop: theme.spacing.md, marginBottom: theme.spacing.xs, color: theme.colors.text },
  field: { marginBottom: theme.spacing.sm },
  bodyInput: { minHeight: 260, textAlignVertical: "top" },
  rtlInput: { textAlign: "right", writingDirection: "rtl" },
  ltrInput: { textAlign: "left", writingDirection: "ltr" },
  problems: { backgroundColor: theme.colors.warningBg, borderRadius: theme.radius.md, padding: theme.spacing.sm, gap: 2, marginTop: theme.spacing.xs },
  problemTxt: { color: theme.colors.text },
  historyRow: { paddingVertical: theme.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.borderMuted, gap: 2 },
  historyRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  historyHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  historyTitle: { fontWeight: "800" },
  historyActions: { flexDirection: "row", gap: theme.spacing.lg },
  link: { minHeight: 44, justifyContent: "center" },
  linkTxt: { color: theme.colors.cta, fontWeight: "800" },
  previewCard: { padding: theme.spacing.lg },
  previewCardNarrow: { padding: theme.spacing.md },
  previewBody: { flex: 1, minHeight: 0 },
  previewHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, marginBottom: theme.spacing.md },
  previewChip: { backgroundColor: theme.colors.infoBg, borderRadius: theme.radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  previewChipTxt: { color: theme.colors.text, fontWeight: "800" },
  previewClose: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  close: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: theme.spacing.xs },
  closeTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  discardTxt: { color: theme.colors.error, fontWeight: "800" },
  publishCard: { padding: theme.spacing.lg, maxWidth: 520 },
  publishBody: { marginBottom: theme.spacing.sm, lineHeight: 21 },
  publishActions: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
});
