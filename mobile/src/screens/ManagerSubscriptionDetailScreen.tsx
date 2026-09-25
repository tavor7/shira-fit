import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { supabase } from "../lib/supabase";
import { EmptyState } from "../components/EmptyState";
import { PrimaryButton } from "../components/PrimaryButton";
import { formatISODateFull } from "../lib/dateFormat";
import { EditSubscriptionModal } from "../components/subscriptions/EditSubscriptionModal";
import { FreezeSubscriptionModal } from "../components/subscriptions/FreezeSubscriptionModal";
import { StopSubscriptionModal } from "../components/subscriptions/StopSubscriptionModal";
import { ReactivateSubscriptionModal } from "../components/subscriptions/ReactivateSubscriptionModal";
import {
  currentEffectiveChargeAmount,
  rpcDeleteSubscription,
  rpcGetSubscriptionDetail,
  tierLabelKey,
  type SubscriptionDetail,
  type SubscriptionVersionRow,
} from "../lib/subscriptions";

const ACTIVE_STATUSES = new Set(["active", "frozen", "scheduled"]);

export function ManagerSubscriptionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, language, isRTL } = useI18n();
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();

  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [payeeName, setPayeeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await rpcGetSubscriptionDetail(supabase, String(id));
      if (!res.ok) {
        setError(res.error);
        setDetail(null);
        return;
      }
      setDetail(res);
      const sub = res.subscription;
      if (sub.payee_is_manual) {
        const { data } = await supabase.from("manual_participants").select("full_name").eq("id", sub.payee_id).maybeSingle();
        setPayeeName(data?.full_name ?? "");
      } else {
        const { data } = await supabase.from("profiles").select("full_name").eq("user_id", sub.payee_id).maybeSingle();
        setPayeeName(data?.full_name ?? "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscriptions.detail.loadError"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centerScreen}>
        <ActivityIndicator color={theme.colors.cta} />
      </View>
    );
  }

  if (error || !detail) {
    return (
      <View style={styles.screen}>
        <EmptyState icon="⚠️" title={t("subscriptions.detail.loadError")} actionLabel={t("subscriptions.retry")} onAction={() => void load()} isRTL={isRTL} />
      </View>
    );
  }

  const versions = [...detail.versions].sort((a, b) => a.version_no - b.version_no);
  const current: SubscriptionVersionRow | undefined = versions.find((v) => v.effective_to === null) ?? versions[versions.length - 1];
  const isActiveGroup = current ? ACTIVE_STATUSES.has(current.display_status) : false;
  const isTombstoned = detail.subscription.deleted_at != null;
  const activeFreeze = detail.freezes.find(
    (f) => !f.cancelled_at && f.freeze_from <= todayIso() && f.freeze_until >= todayIso()
  );

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function requestDelete() {
    showConfirm({
      title: t("subscriptions.delete.title"),
      message: t("subscriptions.delete.message"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("subscriptions.delete.confirmLabel"),
      confirmVariant: "danger",
      onConfirm: () => void runDelete(),
    });
  }

  async function runDelete() {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      const res = await rpcDeleteSubscription(supabase, String(id));
      if (!res.ok) {
        showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        return;
      }
      showToast({ message: t("subscriptions.delete.success"), variant: "success" });
      router.replace("/(app)/manager/subscriptions");
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{payeeName || t("subscriptions.detail.title")}</Text>

        <Section title={t("subscriptions.detail.overview")} isRTL={isRTL}>
          <KeyValue label={t("subscriptions.detail.price")} value={`₪${(current?.monthly_price_ils ?? 0).toFixed(2)}`} isRTL={isRTL} />
          <KeyValue label={t("subscriptions.rowStart")} value={formatISODateFull(current?.plan_start_date ?? "", language)} isRTL={isRTL} />
          <KeyValue
            label={t("subscriptions.rowEnd")}
            value={current?.has_no_end_date || !current?.plan_end_date ? t("subscriptions.noEndDate") : formatISODateFull(current.plan_end_date, language)}
            isRTL={isRTL}
          />
          <KeyValue label={t("subscriptions.detail.anchorDay")} value={t("subscriptions.detail.anchorDayValue").replace("{day}", String(current?.anchor_day ?? ""))} isRTL={isRTL} />
          {activeFreeze ? (
            <KeyValue
              label={t("subscriptions.frozenBadge")}
              value={t("subscriptions.detail.frozenNotice")
                .replace("{from}", formatISODateFull(activeFreeze.freeze_from, language))
                .replace("{until}", formatISODateFull(activeFreeze.freeze_until, language))}
              isRTL={isRTL}
            />
          ) : null}
        </Section>

        <Section title={t("subscriptions.allowancesTitle")} isRTL={isRTL}>
          {Object.entries(current?.allowances ?? {})
            .filter(([, n]) => (n ?? 0) > 0)
            .map(([tier, n]) => (
              <Text key={tier} style={[styles.allowanceLine, isRTL && styles.rtl]}>
                {t(tierLabelKey(tier as Parameters<typeof tierLabelKey>[0]))} — {n} {t("subscriptions.perWeek")}
              </Text>
            ))}
          {Object.values(current?.allowances ?? {}).every((n) => !n) ? (
            <Text style={[styles.allowanceLine, isRTL && styles.rtl]}>{t("subscriptions.notIncluded")}</Text>
          ) : null}
        </Section>

        <Section title={t("subscriptions.detail.versionHistoryTitle")} isRTL={isRTL}>
          {versions.map((v) => (
            <Text key={v.id} style={[styles.historyLine, isRTL && styles.rtl]}>
              {t("subscriptions.detail.versionLine")
                .replace("{start}", formatISODateFull(v.effective_from, language))
                .replace("{end}", v.effective_to ? formatISODateFull(v.effective_to, language) : t("subscriptions.detail.versionOngoing"))
                .replace("{price}", v.monthly_price_ils.toFixed(2))}
            </Text>
          ))}
        </Section>

        <Section title={t("subscriptions.detail.freezeHistoryTitle")} isRTL={isRTL}>
          {detail.freezes.length === 0 ? (
            <Text style={[styles.historyLine, isRTL && styles.rtl]}>{t("subscriptions.detail.noFreezes")}</Text>
          ) : (
            detail.freezes.map((f) => (
              <Text key={f.id} style={[styles.historyLine, isRTL && styles.rtl]}>
                {formatISODateFull(f.freeze_from, language)} – {formatISODateFull(f.freeze_until, language)}
                {f.cancelled_at ? ` (${t("common.cancel")})` : ""}
              </Text>
            ))
          )}
        </Section>

        <Section title={t("subscriptions.detail.billingHistoryTitle")} isRTL={isRTL}>
          {detail.billing_periods.length === 0 ? (
            <Text style={[styles.historyLine, isRTL && styles.rtl]}>{t("subscriptions.detail.noBillingYet")}</Text>
          ) : (
            detail.billing_periods.map((p) => {
              const amount = currentEffectiveChargeAmount(p.charges);
              return (
                <Text key={p.period_id} style={[styles.historyLine, isRTL && styles.rtl]}>
                  {t("subscriptions.detail.periodLabel").replace("{start}", formatISODateFull(p.period_start, language)).replace("{end}", formatISODateFull(p.period_end, language))}
                  {amount != null ? `: ₪${amount.toFixed(2)}` : ""}
                </Text>
              );
            })
          )}
        </Section>

        <Section title={t("subscriptions.detail.actionsTitle")} isRTL={isRTL}>
          <View style={styles.actions}>
            {!isTombstoned && isActiveGroup ? (
              <>
                <PrimaryButton label={t("subscriptions.action.edit")} onPress={() => setEditOpen(true)} variant="ghost" style={styles.actionBtn} />
                <PrimaryButton label={t("subscriptions.action.freeze")} onPress={() => setFreezeOpen(true)} variant="ghost" style={styles.actionBtn} />
                <PrimaryButton label={t("subscriptions.action.stop")} onPress={() => setStopOpen(true)} variant="ghost" style={styles.actionBtn} />
              </>
            ) : null}
            {!isTombstoned && !isActiveGroup ? (
              <PrimaryButton label={t("subscriptions.action.reactivate")} onPress={() => setReactivateOpen(true)} variant="ghost" style={styles.actionBtn} />
            ) : null}
            {!isTombstoned ? (
              <PrimaryButton label={t("subscriptions.action.delete")} onPress={requestDelete} loading={deleting} variant="danger" style={styles.actionBtn} />
            ) : null}
          </View>
        </Section>
      </ScrollView>

      {current ? (
        <>
          <EditSubscriptionModal
            visible={editOpen}
            subscriptionId={String(id)}
            subscriptionStartDate={versions[0]?.plan_start_date ?? current.plan_start_date}
            currentPrice={current.monthly_price_ils}
            currentEndDate={current.plan_end_date}
            currentAllowances={current.allowances}
            onClose={() => setEditOpen(false)}
            onSaved={() => {
              setEditOpen(false);
              void load();
            }}
          />
          <FreezeSubscriptionModal
            visible={freezeOpen}
            subscriptionId={String(id)}
            onClose={() => setFreezeOpen(false)}
            onSaved={() => {
              setFreezeOpen(false);
              void load();
            }}
          />
          <StopSubscriptionModal
            visible={stopOpen}
            subscriptionId={String(id)}
            onClose={() => setStopOpen(false)}
            onSaved={() => {
              setStopOpen(false);
              void load();
            }}
          />
          <ReactivateSubscriptionModal
            visible={reactivateOpen}
            sourceSubscriptionId={String(id)}
            sourcePrice={current.monthly_price_ils}
            sourceAllowances={current.allowances}
            onClose={() => setReactivateOpen(false)}
            onCreated={(newId) => {
              setReactivateOpen(false);
              router.replace(`/(app)/manager/subscriptions/${newId}`);
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function Section({ title, isRTL, children }: { title: string; isRTL: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function KeyValue({ label, value, isRTL }: { label: string; value: string; isRTL: boolean }) {
  return (
    <View style={[styles.kv, isRTL && styles.kvRtl]}>
      <Text style={[styles.kvLabel, isRTL && styles.rtl]}>{label}</Text>
      <Text style={[styles.kvValue, isRTL && styles.rtl]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  centerScreen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, alignItems: "center", justifyContent: "center" },
  scroll: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: 60 },
  title: { fontSize: 20, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.md },
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  sectionTitle: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", marginBottom: theme.spacing.sm },
  sectionBody: { gap: 6 },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm },
  kvRtl: { flexDirection: "row-reverse" },
  kvLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  kvValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  allowanceLine: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  historyLine: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  actionBtn: { flexGrow: 1, minWidth: 120 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
