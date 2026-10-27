import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useToast } from "../context/ToastContext";
import { AppText } from "../components/AppText";
import { AppSwitch } from "../components/AppSwitch";
import { Skeleton } from "../components/Skeleton";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import {
  fetchArchiveHealth,
  fetchBackupAutomationState,
  fetchBackupHealth,
  setBackupAutomationEnabled,
  BackupAutomationUnavailableError,
  type ArchiveHealth,
  type BackupAutomationState,
  type BackupHealthSnapshot,
} from "../lib/backupManagement";
import {
  fetchManualBackupHistory,
  fetchManualBackupStatus,
  generateManualBackupRequestId,
  triggerManualBackup,
  verifyGithubIntegration,
  ACTIVE_MANUAL_BACKUP_STATUSES,
  ManualBackupRejectedError,
  type ManualBackupRequest,
} from "../lib/manualBackup";
import { rowFlipFor } from "../lib/layoutDirection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { useRefetchOnResume } from "../hooks/useRefetchOnResume";

const MANUAL_BACKUP_POLL_MS = 5000;
const MANUAL_BACKUP_POLL_MAX_MS = 20 * 60 * 1000; // bounded -- stop polling after 20 minutes even if still "active"

function manualBackupStageLabel(step: string | null, t: (k: string) => string): string {
  switch (step) {
    case "preparing":
      return t("backupMgmt.manual.stage.preparing");
    case "creating_and_uploading":
      return t("backupMgmt.manual.stage.creatingAndUploading");
    case "verifying":
      return t("backupMgmt.manual.stage.verifying");
    case "running_health_checks":
      return t("backupMgmt.manual.stage.runningHealthChecks");
    case "completed_successfully":
      return t("backupMgmt.manual.stage.completedSuccessfully");
    case "waiting_to_start":
    default:
      return t("backupMgmt.manual.stage.waitingToStart");
  }
}

function manualBackupStatusLabel(req: ManualBackupRequest, t: (k: string) => string): string {
  if (req.status === "completed") return manualBackupStageLabel("completed_successfully", t);
  if (req.status === "failed") return t("backupMgmt.manual.stage.failed");
  if (req.status === "unknown") return t("backupMgmt.manual.stage.unknown");
  return manualBackupStageLabel(req.currentStep, t);
}

/** KB-aware (never shows a misleading "0 MB" for a genuinely small size) -- callers pass `null`
 *  explicitly (never call this with null) when the size is actually unknown, showing a dedicated
 *  "unavailable" string instead of any number. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

type Row = { label: string; value: string; warn?: boolean };

/** Label above value (not side-by-side) -- a long label next to a long value previously
 *  overlapped and wrapped incorrectly on narrow screens; stacking removes that failure mode
 *  regardless of how long either Hebrew or English text ends up being, at any screen width. */
function StatusRow({ label, value, warn, isRTL }: Row & { isRTL: boolean }) {
  return (
    <View style={styles.statRow}>
      <AppText variant="caption" muted isRTL={isRTL} style={styles.statLabel}>
        {label}
      </AppText>
      <AppText variant="body" isRTL={isRTL} style={[styles.statValue, warn && styles.statValueWarn]}>
        {value}
      </AppText>
    </View>
  );
}

/** Collapsed by default -- same chevron-toggle convention as CollapsibleDateRangeCard. Keeps the
 *  screen's primary, always-visible metrics short; secondary/technical detail lives here instead
 *  of adding to the main scroll length. */
function ExpandableSection({ title, isRTL, children }: { title: string; isRTL: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.expandable}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.expandableToggle, rowFlipFor(isRTL) && styles.expandableToggleRtl, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <AppText variant="caption" isRTL={isRTL} style={styles.expandableToggleTxt}>
          {title}
        </AppText>
        <AppText variant="caption" style={styles.expandableChevron}>
          {open ? "︿" : "﹀"}
        </AppText>
      </Pressable>
      {open ? <View style={styles.expandableBody}>{children}</View> : null}
    </View>
  );
}

export default function ManagerBackupManagementScreen() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showConfirm, showOk } = useAppAlert();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [backup, setBackup] = useState<BackupHealthSnapshot | null>(null);
  const [archive, setArchive] = useState<ArchiveHealth | null>(null);
  const [automation, setAutomation] = useState<BackupAutomationState | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [manualHistory, setManualHistory] = useState<ManualBackupRequest[]>([]);
  const [manualBusy, setManualBusy] = useState(false);
  const [githubCheckBusy, setGithubCheckBusy] = useState(false);

  const replace = useCallback((key: string, n: number) => t(key).replace("{n}", String(n)), [t]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [b, a, auto, manual] = await Promise.all([
        fetchBackupHealth(),
        fetchArchiveHealth(),
        fetchBackupAutomationState(),
        fetchManualBackupHistory(5),
      ]);
      setBackup(b);
      setArchive(a);
      setAutomation(auto);
      setManualHistory(manual);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRefetchOnResume(
    () => void load(),
    () => !loading,
    30_000
  );

  const activeManualRequest = manualHistory.find((r) => ACTIVE_MANUAL_BACKUP_STATUSES.includes(r.status));

  // Bounded polling: only while a request is actually active, stops itself after
  // MANUAL_BACKUP_POLL_MAX_MS even if somehow still "active" (e.g. correlation got stuck), and
  // always cleans up its interval on unmount or when the active request changes/clears.
  useEffect(() => {
    if (!activeManualRequest) return;
    const startedAt = Date.now();
    const id = activeManualRequest.id;
    const interval = setInterval(() => {
      if (Date.now() - startedAt > MANUAL_BACKUP_POLL_MAX_MS) {
        clearInterval(interval);
        return;
      }
      fetchManualBackupStatus(id)
        .then((updated) => {
          setManualHistory((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
          if (!ACTIVE_MANUAL_BACKUP_STATUSES.includes(updated.status)) {
            clearInterval(interval);
            void load(); // refresh backup history/health now that a run just finished
          }
        })
        .catch(() => {
          /* transient poll failure -- next tick retries; the request's own status is untouched */
        });
    }, MANUAL_BACKUP_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the active request's id only
  }, [activeManualRequest?.id]);

  async function onBackUpNow() {
    if (manualBusy || activeManualRequest) return;
    setManualBusy(true);
    const clientRequestId = generateManualBackupRequestId();
    try {
      const req = await triggerManualBackup(clientRequestId);
      setManualHistory((prev) => [req, ...prev.filter((r) => r.id !== req.id)].slice(0, 5));
      showToast({ message: t("backupMgmt.manual.requestAccepted"), variant: "success" });
    } catch (e) {
      if (e instanceof ManualBackupRejectedError) {
        if (e.code === "rate_limited") {
          showToast({ message: t("backupMgmt.manual.rateLimited"), variant: "info" });
        } else if (e.code === "github_dispatch_not_configured") {
          showToast({ message: t("backupMgmt.manual.notConfigured"), variant: "error" });
        } else if (e.existingRequest) {
          setManualHistory((prev) => [e.existingRequest!, ...prev.filter((r) => r.id !== e.existingRequest!.id)].slice(0, 5));
          showToast({ message: t("backupMgmt.manual.alreadyActive"), variant: "info" });
        } else {
          showToast({ message: t("common.error"), detail: e.code, variant: "error" });
        }
      } else {
        showToast({ message: t("common.error"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
      }
    } finally {
      setManualBusy(false);
    }
  }

  function onPressBackUpNow() {
    showConfirm({
      title: t("backupMgmt.manual.confirmTitle"),
      message: t("backupMgmt.manual.confirmBody"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("backupMgmt.manual.confirm"),
      confirmVariant: "primary",
      onConfirm: () => void onBackUpNow(),
    });
  }

  /** Strictly read-only -- never dispatches a backup. Lets a manager confirm the GitHub
   *  integration (token validity, repo/workflow visibility) is ready before ever pressing
   *  "Back Up Now" for real. */
  async function onTestGithubConnection() {
    if (githubCheckBusy) return;
    setGithubCheckBusy(true);
    try {
      const result = await verifyGithubIntegration();
      if (result.ok) {
        showOk(
          t("backupMgmt.manual.testConnectionOkTitle"),
          t("backupMgmt.manual.testConnectionOkBody").replace("{n}", String(result.recentRunCount ?? 0))
        );
      } else if (result.error === "github_dispatch_not_configured") {
        showOk(t("backupMgmt.manual.testConnectionFailTitle"), t("backupMgmt.manual.notConfigured"));
      } else {
        showOk(
          t("backupMgmt.manual.testConnectionFailTitle"),
          `${t("backupMgmt.manual.testConnectionFailBody")} (${result.error ?? "unknown"})`
        );
      }
    } catch (e) {
      showOk(t("backupMgmt.manual.testConnectionFailTitle"), e instanceof Error ? e.message : t("common.error"));
    } finally {
      setGithubCheckBusy(false);
    }
  }

  async function applyAutomationChange(nextEnabled: boolean) {
    if (automationBusy) return; // prevents a double-tap from firing two requests
    setAutomationBusy(true);
    try {
      const state = await setBackupAutomationEnabled(nextEnabled);
      setAutomation(state);
      showToast({
        message: nextEnabled ? t("backupMgmt.automation.enabledToast") : t("backupMgmt.automation.disabledToast"),
        variant: "success",
      });
    } catch (e) {
      if (e instanceof BackupAutomationUnavailableError) {
        showToast({ message: t("backupMgmt.automation.unavailable"), variant: "error" });
      } else {
        showToast({ message: t("common.error"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
      }
    } finally {
      setAutomationBusy(false);
    }
  }

  function onToggleAutomation(nextEnabled: boolean) {
    showConfirm({
      title: nextEnabled ? t("backupMgmt.automation.confirmEnableTitle") : t("backupMgmt.automation.confirmDisableTitle"),
      message: nextEnabled ? t("backupMgmt.automation.confirmEnableBody") : t("backupMgmt.automation.confirmDisableBody"),
      cancelLabel: t("common.cancel"),
      confirmLabel: nextEnabled ? t("backupMgmt.automation.enable") : t("backupMgmt.automation.disable"),
      confirmVariant: nextEnabled ? "primary" : "danger",
      onConfirm: () => void applyAutomationChange(nextEnabled),
    });
  }

  const h = backup?.health;
  const automationOn = !!automation?.enabled;

  // Automation-aware: a disabled schedule is a manager CHOICE, not a missed run -- staleness
  // warnings only fire while automation is actually on. Genuine correctness problems (a manifest
  // with a missing artifact, an actual failed restore-test, archive upload/checksum failures)
  // are real regardless of the automation setting and always warn.
  const attention: string[] = [];
  const advisories: string[] = [];
  if (h) {
    if (automationOn) {
      if (h.backup_is_stale) attention.push(t("backupMgmt.financial.stale.backup"));
      if (h.verification_is_stale) attention.push(t("backupMgmt.financial.stale.verification"));
      if (h.restore_test_is_stale) attention.push(t("backupMgmt.financial.stale.restoreTest"));
    } else if (h.last_successful_backup) {
      advisories.push(
        t("backupMgmt.financial.advisory.ageWhileOff").replace(
          "{when}",
          formatDateTimeForDisplay(h.last_successful_backup.created_at, language)
        )
      );
    }
    if ((h.incomplete_backups ?? 0) > 0) attention.push(replace("backupMgmt.financial.problem.incomplete", h.incomplete_backups ?? 0));
    if (h.last_restore_test?.result === "failed") attention.push(t("backupMgmt.financial.problem.restoreTestFailed"));
  }
  if (archive && archive.failed_count > 0) attention.push(replace("backupMgmt.archive.problem.failed", archive.failed_count));
  if (archive && archive.hash_mismatch_count > 0) attention.push(replace("backupMgmt.archive.problem.hashMismatch", archive.hash_mismatch_count));

  if (loading) {
    return (
      <View style={styles.root}>
        <ManagerStudioSetupTabs />
        <Skeleton height={220} style={styles.skeleton} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.root}>
        <ManagerStudioSetupTabs />
        <View style={[styles.card, styles.errorCard]}>
          <AppText variant="body" isRTL={isRTL} style={styles.errorText}>
            {t("backupMgmt.loadError")}
          </AppText>
          <Pressable onPress={() => void load()} style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <AppText variant="body" style={styles.retryBtnTxt}>
              {t("backupMgmt.retry")}
            </AppText>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.container, screenContent]}>
      <ManagerStudioSetupTabs />

      <AppText variant="caption" muted isRTL={isRTL} style={styles.hint}>
        {t("backupMgmt.hint")}
      </AppText>

      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("backupMgmt.automation.title")}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.cardDesc}>
          {t("backupMgmt.automation.description")}
        </AppText>

        <View style={[styles.toggleRow, rowFlipFor(isRTL) && styles.toggleRowRtl]}>
          <AppText variant="body" isRTL={isRTL} style={styles.toggleLabel}>
            {automationOn ? t("backupMgmt.automation.stateOn") : t("backupMgmt.automation.stateOff")}
          </AppText>
          <AppSwitch
            value={automationOn}
            onValueChange={onToggleAutomation}
            onColor={theme.colors.success}
            accessibilityLabel={t("backupMgmt.automation.title")}
            disabled={automationBusy || !automation}
          />
        </View>

        {automation?.changedAt ? (
          <AppText variant="caption" muted isRTL={isRTL} style={styles.snapshotAge}>
            {t("backupMgmt.automation.lastChanged")
              .replace("{when}", formatDateTimeForDisplay(automation.changedAt, language))
              .replace("{who}", automation.changedByLabel ?? "—")}
          </AppText>
        ) : null}

        {/* Always the short, manager-facing description -- never the DST-guard implementation
            detail from health.js's own next_scheduled_* strings (those are for logs/docs). */}
        <StatusRow isRTL={isRTL} label={t("backupMgmt.automation.dailySchedule")} value={t("backupMgmt.automation.scheduleFallbackDaily")} />
        <StatusRow isRTL={isRTL} label={t("backupMgmt.automation.weeklySchedule")} value={t("backupMgmt.automation.scheduleFallbackWeekly")} />
      </View>

      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("backupMgmt.manual.title")}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.cardDesc}>
          {t("backupMgmt.manual.description")}
        </AppText>

        <Pressable
          onPress={onPressBackUpNow}
          disabled={manualBusy || !!activeManualRequest}
          accessibilityRole="button"
          accessibilityState={{ disabled: manualBusy || !!activeManualRequest }}
          style={({ pressed }) => [
            styles.backUpNowBtn,
            (manualBusy || !!activeManualRequest) && styles.backUpNowBtnDisabled,
            pressed && !(manualBusy || !!activeManualRequest) && { opacity: 0.85 },
          ]}
        >
          <AppText variant="body" style={styles.backUpNowBtnTxt}>
            {t("backupMgmt.manual.button")}
          </AppText>
        </Pressable>

        <Pressable
          onPress={() => void onTestGithubConnection()}
          disabled={githubCheckBusy}
          accessibilityRole="button"
          style={({ pressed }) => [styles.testConnectionBtn, pressed && !githubCheckBusy && { opacity: 0.7 }]}
        >
          <AppText variant="caption" muted isRTL={isRTL} style={styles.testConnectionBtnTxt}>
            {githubCheckBusy ? t("common.loading") : t("backupMgmt.manual.testConnection")}
          </AppText>
        </Pressable>

        {manualHistory.length > 0 ? (
          <View style={styles.manualHistory}>
            {manualHistory.map((req) => (
              <View key={req.id} style={[styles.historyRow, rowFlipFor(isRTL) && styles.historyRowRtl]}>
                <AppText variant="body" isRTL={isRTL} style={styles.historyDate} numberOfLines={1}>
                  {formatDateTimeForDisplay(req.requestedAt, language)}
                </AppText>
                <AppText
                  variant="body"
                  isRTL={isRTL}
                  style={[styles.historyStatus, (req.status === "failed" || req.status === "unknown") && styles.statValueWarn]}
                  numberOfLines={1}
                >
                  {manualBackupStatusLabel(req, t)}
                </AppText>
              </View>
            ))}
          </View>
        ) : (
          <AppText variant="body" muted isRTL={isRTL} style={styles.manualHistory}>
            {t("backupMgmt.manual.noHistory")}
          </AppText>
        )}
      </View>

      {attention.length > 0 && (
        <View style={[styles.card, styles.attentionCard]}>
          <AppText variant="title" isRTL={isRTL} style={styles.attentionTitle}>
            {t("backupMgmt.attention.title")}
          </AppText>
          {attention.map((a, i) => (
            <AppText key={i} variant="body" isRTL={isRTL} style={styles.attentionItem}>
              {"⚠ "}
              {a}
            </AppText>
          ))}
        </View>
      )}

      {advisories.length > 0 && (
        <View style={[styles.card, styles.advisoryCard]}>
          {advisories.map((a, i) => (
            <AppText key={i} variant="caption" muted isRTL={isRTL} style={styles.attentionItem}>
              {"ℹ︎ "}
              {a}
            </AppText>
          ))}
        </View>
      )}

      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("backupMgmt.financial.title")}
        </AppText>

        {!backup?.has_data || !h ? (
          <AppText variant="body" muted isRTL={isRTL}>
            {t("backupMgmt.financial.noData")}
          </AppText>
        ) : (
          <>
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.financial.lastBackup")}
              value={h.last_successful_backup ? formatDateTimeForDisplay(h.last_successful_backup.created_at, language) : "—"}
              warn={automationOn && h.backup_is_stale}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.financial.lastRestoreTest")}
              value={
                h.last_restore_test
                  ? `${h.last_restore_test.result === "passed" ? t("backupMgmt.financial.restoreTest.passed") : t("backupMgmt.financial.restoreTest.failed")} · ${formatDateTimeForDisplay(h.last_restore_test.tested_at, language)}`
                  : t("backupMgmt.financial.restoreTest.none")
              }
              warn={h.last_restore_test?.result === "failed" || (automationOn && h.restore_test_is_stale)}
            />
            <AppText variant="body" isRTL={isRTL} style={[styles.coverageNote, !h.newest_backup_restore_tested && styles.statValueWarn]}>
              {h.newest_backup_restore_tested ? t("backupMgmt.financial.restoreTest.latestCovered") : t("backupMgmt.financial.restoreTest.latestNotCovered")}
            </AppText>

            <ExpandableSection title={t("backupMgmt.showDetails")} isRTL={isRTL}>
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.financial.lastVerified")}
                value={h.last_verified_backup ? formatDateTimeForDisplay(h.last_verified_backup.verified_at, language) : "—"}
                warn={automationOn && h.verification_is_stale}
              />
              <StatusRow isRTL={isRTL} label={t("backupMgmt.financial.totalBackups")} value={String(h.total_backups ?? 0)} />
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.financial.totalSize")}
                value={h.total_size_bytes != null ? formatBytes(h.total_size_bytes) : t("backupMgmt.archive.sizeUnavailable")}
              />
              {backup?.computed_at ? (
                <AppText variant="caption" muted isRTL={isRTL} style={styles.snapshotAge}>
                  {t("backupMgmt.financial.snapshotAge").replace("{when}", formatDateTimeForDisplay(backup.computed_at, language))}
                </AppText>
              ) : null}
            </ExpandableSection>
          </>
        )}
      </View>

      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("backupMgmt.archive.title")}
        </AppText>

        {!archive ? (
          <AppText variant="body" muted isRTL={isRTL}>
            {t("backupMgmt.financial.noData")}
          </AppText>
        ) : (
          <>
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.archived")} value={String(archive.archived_count)} />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.archive.coverage")}
              value={archive.upload_coverage_pct !== null ? `${archive.upload_coverage_pct}%` : "—"}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.archive.integrityCheckedPct")}
              value={archive.integrity_checked_pct !== null ? `${archive.integrity_checked_pct}%` : "—"}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.archive.problemsFound")}
              value={String(archive.failed_count + archive.hash_mismatch_count)}
              warn={archive.failed_count + archive.hash_mismatch_count > 0}
            />

            <ExpandableSection title={t("backupMgmt.showDetails")} isRTL={isRTL}>
              <AppText variant="caption" muted isRTL={isRTL} style={styles.sectionLabel}>
                {t("backupMgmt.archive.uploadSection")}
              </AppText>
              <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.pending")} value={String(archive.pending_count)} />
              <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.failed")} value={String(archive.failed_count)} warn={archive.failed_count > 0} />
              <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.pdfVersions")} value={String(archive.total_pdf_version_count)} />
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.archive.totalSize")}
                value={archive.total_size_bytes != null ? formatBytes(archive.total_size_bytes) : t("backupMgmt.archive.sizeUnavailable")}
              />

              <AppText variant="caption" muted isRTL={isRTL} style={styles.sectionLabel}>
                {t("backupMgmt.archive.integritySection")}
              </AppText>
              <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.hashVerified")} value={String(archive.hash_verified_count)} />
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.archive.hashMismatch")}
                value={String(archive.hash_mismatch_count)}
                warn={archive.hash_mismatch_count > 0}
              />
              <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.neverChecked")} value={String(archive.never_integrity_checked_count)} />
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.archive.lastReconciliation")}
                value={archive.last_reconciliation ? formatDateTimeForDisplay(archive.last_reconciliation.started_at, language) : t("backupMgmt.archive.never")}
              />
              <StatusRow
                isRTL={isRTL}
                label={t("backupMgmt.archive.lastIntegrityCheck")}
                value={
                  archive.last_integrity_verification
                    ? formatDateTimeForDisplay(archive.last_integrity_verification.started_at, language)
                    : t("backupMgmt.archive.never")
                }
              />
            </ExpandableSection>
          </>
        )}
      </View>

      <Pressable
        onPress={() => router.push("/(app)/manager/documents-invoices" as never)}
        accessibilityRole="link"
        style={({ pressed }) => [styles.card, styles.exportLinkCard, pressed && { opacity: 0.8 }]}
      >
        <View style={styles.exportLinkTextWrap}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
            {t("backupMgmt.export.title")}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL}>
            {t("backupMgmt.export.description")}
          </AppText>
        </View>
        <AppText variant="body" style={styles.exportLinkArrow}>
          {isRTL ? "‹" : "›"}
        </AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { padding: theme.spacing.md, gap: theme.spacing.md },
  skeleton: { margin: theme.spacing.md, borderRadius: theme.radius.lg },
  hint: { marginBottom: theme.spacing.xs, lineHeight: 18 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  errorCard: { alignItems: "center", gap: theme.spacing.sm },
  errorText: { textAlign: "center" },
  retryBtn: {
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  retryBtnTxt: { color: theme.colors.ctaText, fontWeight: "800" },
  attentionCard: { backgroundColor: theme.colors.warningBg, borderColor: theme.colors.warningBorder },
  attentionTitle: { marginBottom: theme.spacing.xs, color: theme.colors.warning },
  attentionItem: { marginTop: 2 },
  advisoryCard: { backgroundColor: theme.colors.surfaceElevated, paddingVertical: theme.spacing.sm },
  cardTitle: { marginBottom: theme.spacing.sm },
  cardDesc: { marginBottom: theme.spacing.sm, lineHeight: 19 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.spacing.xs },
  toggleRowRtl: { flexDirection: "row-reverse" },
  toggleLabel: { flex: 1, fontWeight: "700" },
  // Stacked (label above value), not side-by-side -- a long label and a long value next to each
  // other previously overlapped/wrapped incorrectly on narrow screens; stacking is immune to
  // that regardless of text length/language.
  statRow: {
    paddingVertical: theme.spacing.xs,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  statLabel: { opacity: 0.8 },
  statValue: { fontWeight: "700" },
  statValueWarn: { color: theme.colors.warning },
  sectionLabel: { marginTop: theme.spacing.sm, marginBottom: theme.spacing.xs, textTransform: "uppercase", letterSpacing: 0.5 },
  // Manual-backup history rows stay side-by-side (date + a short status word, both always short
  // enough not to collide) -- distinct styles from statRow/statLabel/statValue above.
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
    gap: theme.spacing.sm,
  },
  historyRowRtl: { flexDirection: "row-reverse" },
  historyDate: { flex: 1, opacity: 0.8 },
  historyStatus: { fontWeight: "700", flexShrink: 0 },
  coverageNote: { marginTop: theme.spacing.sm, fontWeight: "700" },
  snapshotAge: { marginTop: theme.spacing.xs },
  backUpNowBtn: {
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
    marginTop: theme.spacing.xs,
  },
  backUpNowBtnDisabled: { opacity: 0.5 },
  backUpNowBtnTxt: { color: theme.colors.ctaText, fontWeight: "800" },
  testConnectionBtn: { alignItems: "center", paddingVertical: theme.spacing.xs, marginTop: theme.spacing.xs },
  testConnectionBtnTxt: { textDecorationLine: "underline" },
  exportLinkCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.spacing.md },
  exportLinkTextWrap: { flex: 1, gap: 2 },
  exportLinkArrow: { fontSize: 24, color: theme.colors.textSoft },
  manualHistory: { marginTop: theme.spacing.sm },
  expandable: { marginTop: theme.spacing.xs },
  expandableToggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.spacing.xs, minHeight: 32 },
  expandableToggleRtl: { flexDirection: "row-reverse" },
  expandableToggleTxt: { fontWeight: "700", color: theme.colors.cta },
  expandableChevron: { color: theme.colors.textSoft },
  expandableBody: { marginTop: theme.spacing.xs },
});
