import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
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
import { rowFlipFor } from "../lib/layoutDirection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

type Row = { label: string; value: string; warn?: boolean };

function StatusRow({ label, value, warn, isRTL }: Row & { isRTL: boolean }) {
  return (
    <View style={[styles.statRow, rowFlipFor(isRTL) && styles.statRowRtl]}>
      <AppText variant="body" isRTL={isRTL} style={styles.statLabel}>
        {label}
      </AppText>
      <AppText variant="body" isRTL={isRTL} style={[styles.statValue, warn && styles.statValueWarn]}>
        {value}
      </AppText>
    </View>
  );
}

export default function ManagerBackupManagementScreen() {
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("narrow");
  const { showConfirm } = useAppAlert();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [backup, setBackup] = useState<BackupHealthSnapshot | null>(null);
  const [archive, setArchive] = useState<ArchiveHealth | null>(null);
  const [automation, setAutomation] = useState<BackupAutomationState | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);

  const replace = useCallback((key: string, n: number) => t(key).replace("{n}", String(n)), [t]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [b, a, auto] = await Promise.all([fetchBackupHealth(), fetchArchiveHealth(), fetchBackupAutomationState()]);
      setBackup(b);
      setArchive(a);
      setAutomation(auto);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
  const attention: string[] = [];
  if (h?.backup_is_stale) attention.push(t("backupMgmt.financial.stale.backup"));
  if (h?.verification_is_stale) attention.push(t("backupMgmt.financial.stale.verification"));
  if (h?.restore_test_is_stale) attention.push(t("backupMgmt.financial.stale.restoreTest"));
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
            {automation?.enabled ? t("backupMgmt.automation.stateOn") : t("backupMgmt.automation.stateOff")}
          </AppText>
          <AppSwitch
            value={!!automation?.enabled}
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

        <StatusRow isRTL={isRTL} label={t("backupMgmt.automation.dailySchedule")} value={h?.next_scheduled_backup ?? t("backupMgmt.automation.scheduleFallbackDaily")} />
        <StatusRow isRTL={isRTL} label={t("backupMgmt.automation.weeklySchedule")} value={h?.next_scheduled_restore_test ?? t("backupMgmt.automation.scheduleFallbackWeekly")} />
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
              warn={h.backup_is_stale}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.financial.lastVerified")}
              value={h.last_verified_backup ? formatDateTimeForDisplay(h.last_verified_backup.verified_at, language) : "—"}
              warn={h.verification_is_stale}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.financial.lastRestoreTest")}
              value={
                h.last_restore_test
                  ? `${h.last_restore_test.result === "passed" ? t("backupMgmt.financial.restoreTest.passed") : t("backupMgmt.financial.restoreTest.failed")} · ${formatDateTimeForDisplay(h.last_restore_test.tested_at, language)}`
                  : t("backupMgmt.financial.restoreTest.none")
              }
              warn={h.restore_test_is_stale || h.last_restore_test?.result === "failed"}
            />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.financial.totalBackups")}
              value={String(h.total_backups ?? 0)}
            />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.financial.totalSize")} value={formatBytes(h.total_size_bytes)} />

            <AppText variant="body" isRTL={isRTL} style={[styles.coverageNote, !h.newest_backup_restore_tested && styles.statValueWarn]}>
              {h.newest_backup_restore_tested ? t("backupMgmt.financial.restoreTest.latestCovered") : t("backupMgmt.financial.restoreTest.latestNotCovered")}
            </AppText>

            {backup?.computed_at ? (
              <AppText variant="caption" muted isRTL={isRTL} style={styles.snapshotAge}>
                {t("backupMgmt.financial.snapshotAge").replace("{when}", formatDateTimeForDisplay(backup.computed_at, language))}
              </AppText>
            ) : null}
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
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.archive.coverage")}
              value={archive.coverage_pct !== null ? `${archive.coverage_pct}%` : "—"}
            />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.archived")} value={String(archive.archived_count)} />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.pending")} value={String(archive.pending_count)} />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.failed")} value={String(archive.failed_count)} warn={archive.failed_count > 0} />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.pdfVersions")} value={String(archive.total_pdf_version_count)} />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.totalSize")} value={formatBytes(archive.total_size_bytes)} />
            <StatusRow isRTL={isRTL} label={t("backupMgmt.archive.hashVerified")} value={String(archive.hash_verified_count)} />
            <StatusRow
              isRTL={isRTL}
              label={t("backupMgmt.archive.hashMismatch")}
              value={String(archive.hash_mismatch_count)}
              warn={archive.hash_mismatch_count > 0}
            />
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
          </>
        )}
      </View>
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
  cardTitle: { marginBottom: theme.spacing.sm },
  cardDesc: { marginBottom: theme.spacing.sm, lineHeight: 19 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.spacing.xs },
  toggleRowRtl: { flexDirection: "row-reverse" },
  toggleLabel: { flex: 1, fontWeight: "700" },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  statRowRtl: { flexDirection: "row-reverse" },
  statLabel: { flex: 1, opacity: 0.8 },
  statValue: { fontWeight: "700" },
  statValueWarn: { color: theme.colors.warning },
  coverageNote: { marginTop: theme.spacing.sm, fontWeight: "700" },
  snapshotAge: { marginTop: theme.spacing.xs },
});
