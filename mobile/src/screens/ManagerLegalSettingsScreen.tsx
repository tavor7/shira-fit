import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { AppText } from "../components/AppText";
import { AppSwitch } from "../components/AppSwitch";
import { AppModal } from "../components/AppModal";
import { Skeleton } from "../components/Skeleton";
import { formatDateTimeForDisplay } from "../lib/dateFormat";
import {
  fetchLegalConsentSettings,
  fetchLegalDocumentHistory,
  setLegalConsentGateEnabled,
  type ConsentType,
  type LegalConsentSettings,
  type LegalDocumentVersion,
} from "../lib/consent";

export default function ManagerLegalSettingsScreen() {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<LegalConsentSettings | null>(null);

  const [historyFor, setHistoryFor] = useState<{ consentType: ConsentType; title: string } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<LegalDocumentVersion[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const s = await fetchLegalConsentSettings();
    setSettings(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onToggle(next: boolean) {
    if (!settings || saving) return;
    setSaving(true);
    setSettings({ ...settings, gate_enabled: next });
    try {
      await setLegalConsentGateEnabled(next);
      showToast({ message: t("common.saved"), variant: "success" });
    } catch {
      setSettings((s) => (s ? { ...s, gate_enabled: !next } : s));
      showToast({ message: t("common.failed"), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(consentType: ConsentType, title: string) {
    setHistoryFor({ consentType, title });
    setHistoryLoading(true);
    setHistory(await fetchLegalDocumentHistory(consentType));
    setHistoryLoading(false);
  }

  if (loading) {
    return (
      <View style={styles.root}>
        <Skeleton height={140} style={styles.skeleton} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("managerLegal.title")}
        </AppText>
        <AppText variant="caption" muted isRTL={isRTL} style={styles.cardDesc}>
          {t("managerLegal.description")}
        </AppText>

        <View style={[styles.toggleRow, isRTL && styles.toggleRowRtl]}>
          <AppText variant="body" isRTL={isRTL} style={styles.toggleLabel}>
            {settings?.gate_enabled ? t("managerLegal.gateOn") : t("managerLegal.gateOff")}
          </AppText>
          <AppSwitch
            value={!!settings?.gate_enabled}
            onValueChange={(v) => void onToggle(v)}
            onColor={theme.colors.success}
            accessibilityLabel={t("managerLegal.title")}
            disabled={saving}
          />
        </View>
      </View>

      <View style={styles.card}>
        <AppText variant="title" isRTL={isRTL} style={styles.cardTitle}>
          {t("managerLegal.currentVersions")}
        </AppText>
        {(settings?.documents ?? []).map((d) => {
          const title = language === "en" && d.title_en ? d.title_en : d.title;
          return (
            <Pressable
              key={d.consent_type}
              style={({ pressed }) => [styles.docRow, pressed && styles.docRowPressed]}
              onPress={() => void openHistory(d.consent_type, title)}
              accessibilityRole="button"
              accessibilityLabel={`${title}, v${d.version}, ${t("managerLegal.viewHistory")}`}
            >
              <AppText variant="body" isRTL={isRTL} style={styles.docRowTitle}>
                {title}
              </AppText>
              <AppText variant="caption" muted>
                v{d.version}
              </AppText>
            </Pressable>
          );
        })}
      </View>

      <AppModal
        visible={!!historyFor}
        onClose={() => setHistoryFor(null)}
        variant="sheet"
        backdropAccessibilityLabel={t("common.close")}
      >
        <View style={styles.historySheet}>
          <AppText variant="title" isRTL={isRTL} style={styles.cardTitle} accessibilityRole="header">
            {historyFor?.title}
          </AppText>
          <AppText variant="caption" muted isRTL={isRTL} style={styles.cardDesc}>
            {t("managerLegal.historySubtitle")}
          </AppText>

          {historyFor && (historyFor.consentType === "terms_of_service" || historyFor.consentType === "privacy_policy") ? (
            <Pressable
              onPress={() => {
                setHistoryFor(null);
                router.push(historyFor.consentType === "terms_of_service" ? "/legal/terms" : "/legal/privacy");
              }}
              style={({ pressed }) => [styles.fullDocBtn, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
            >
              <AppText variant="body" style={styles.fullDocBtnTxt}>
                {t("managerLegal.viewFullDocument")}
              </AppText>
            </Pressable>
          ) : null}

          {historyLoading ? (
            <Skeleton height={60} style={styles.skeleton} />
          ) : (
            history.map((v) => (
              <View key={v.version} style={styles.historyRow}>
                <View style={[styles.historyRowHeader, isRTL && styles.toggleRowRtl]}>
                  <AppText variant="body" isRTL={isRTL} style={styles.historyRowTitle}>
                    {language === "en" && v.title_en ? v.title_en : v.title}
                  </AppText>
                  <View style={styles.historyBadges}>
                    <AppText variant="caption" muted>
                      v{v.version}
                    </AppText>
                    {v.is_current ? (
                      <View style={styles.currentBadge}>
                        <AppText variant="caption" style={styles.currentBadgeTxt}>
                          {t("managerLegal.current")}
                        </AppText>
                      </View>
                    ) : null}
                  </View>
                </View>
                <AppText variant="caption" muted isRTL={isRTL} style={styles.historyDate}>
                  {formatDateTimeForDisplay(v.effective_at, language)}
                </AppText>
                <AppText variant="body" isRTL={isRTL} style={styles.historyBody}>
                  {language === "en" && v.body_text_en ? v.body_text_en : v.body_text}
                </AppText>
              </View>
            ))
          )}

          <Pressable
            onPress={() => setHistoryFor(null)}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <AppText variant="body" style={styles.closeBtnTxt}>
              {t("common.close")}
            </AppText>
          </Pressable>
        </View>
      </AppModal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { padding: theme.spacing.lg, gap: theme.spacing.md },
  skeleton: { margin: theme.spacing.lg, borderRadius: theme.radius.lg },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  cardTitle: { marginBottom: theme.spacing.xs },
  cardDesc: { marginBottom: theme.spacing.md, lineHeight: 19 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleRowRtl: { flexDirection: "row-reverse" },
  toggleLabel: { flex: 1 },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.sm,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  docRowPressed: { opacity: 0.7 },
  docRowTitle: { flex: 1 },
  historySheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  fullDocBtn: {
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
    marginBottom: theme.spacing.md,
  },
  fullDocBtnTxt: { color: theme.colors.cta, fontWeight: "800" },
  historyRow: {
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  historyRowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyRowTitle: { flex: 1 },
  historyDate: { marginTop: 2, marginBottom: theme.spacing.xs },
  historyBody: { lineHeight: 21 },
  historyBadges: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs },
  currentBadge: {
    backgroundColor: theme.colors.successBg,
    borderRadius: theme.radius.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  currentBadgeTxt: { color: theme.colors.success, fontWeight: "800" },
  closeBtn: {
    marginTop: theme.spacing.md,
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.cta,
  },
  closeBtnTxt: { color: theme.colors.ctaText, fontWeight: "800" },
});
