import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { supabase } from "../lib/supabase";
import { EmptyState } from "../components/EmptyState";
import { PrimaryButton } from "../components/PrimaryButton";
import { WeeklyAllowanceMeter } from "../components/WeeklyAllowanceMeter";
import { formatISODateDayMonth, formatISODateFull } from "../lib/dateFormat";
import { studioTodayIso, weekBoundsSunday, addStudioWeeksIso } from "../lib/studioWeek";
import { tierUsageFromRow, sessionsLeftLabel, usedOfLimitLabel, extraSessionsLabel } from "../lib/athleteSubscription";
import {
  currentEffectiveChargeAmount,
  fetchSubscriptionPayments,
  rpcDeleteSubscription,
  rpcGetSubscriptionDetail,
  rpcGetSubscriptionWeeklyUsage,
  tierLabelKey,
  type FutureRegistrationAction,
  type FutureRegistrationItem,
  type SubscriptionDetail,
  type SubscriptionPaymentRow,
  type SubscriptionVersionRow,
  type SubscriptionWeeklyUsage,
} from "../lib/subscriptions";
import { AddSubscriptionPaymentModal } from "../components/AddSubscriptionPaymentModal";
import { FutureRegistrationsChoiceModal } from "../components/subscriptions/FutureRegistrationsChoiceModal";
import { paymentMethodHistoryLabel } from "../lib/paymentMethod";
import { rowFlipFor } from "../lib/layoutDirection";
import { managerTermsStatusText, rpcGetSubscriptionTermsStatus, type ManagerTermsStatusItem } from "../lib/subscriptionTerms";
import { displayMoney } from "../lib/displayFormat";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

const ACTIVE_STATUSES = new Set(["active", "frozen", "scheduled"]);

export function ManagerSubscriptionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, language, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("standard");
  const { showToast } = useToast();
  const { showConfirm } = useAppAlert();

  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [payeeName, setPayeeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [terms, setTerms] = useState<ManagerTermsStatusItem | null>(null);
  const [payments, setPayments] = useState<SubscriptionPaymentRow[]>([]);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [futureRegs, setFutureRegs] = useState<FutureRegistrationItem[]>([]);
  const [futureRegsOpen, setFutureRegsOpen] = useState(false);
  const [futureRegsNotice, setFutureRegsNotice] = useState<string | undefined>(undefined);
  const [weekOffset, setWeekOffset] = useState(0);
  const [usage, setUsage] = useState<SubscriptionWeeklyUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState(false);

  const loadPayments = useCallback(async () => {
    if (!id) return;
    try {
      setPayments(await fetchSubscriptionPayments(supabase, String(id)));
    } catch {
      // Non-critical: the subscription detail itself already loaded; leave the list empty.
    }
  }, [id]);

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
      rpcGetSubscriptionTermsStatus(supabase, [sub.id])
        .then((m) => setTerms(m[sub.id] ?? null))
        .catch(() => setTerms(null));
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

  // Refetch on every focus (returning from the Edit/Freeze/Stop/Reactivate pushed screens must
  // show fresh state, not stale data from before the action was taken).
  useFocusEffect(
    useCallback(() => {
      void load();
      void loadPayments();
    }, [load, loadPayments])
  );

  const weekStart = addStudioWeeksIso(weekBoundsSunday(studioTodayIso()).start, weekOffset);

  const loadUsage = useCallback(
    async (cancelledRef: { current: boolean }) => {
      if (!id) return;
      setUsageLoading(true);
      setUsageError(false);
      try {
        const res = await rpcGetSubscriptionWeeklyUsage(supabase, String(id), weekStart);
        if (cancelledRef.current) return;
        if (!res.ok) {
          setUsage(null);
          setUsageError(true);
          return;
        }
        setUsage(res);
      } catch {
        if (!cancelledRef.current) {
          setUsage(null);
          setUsageError(true);
        }
      } finally {
        if (!cancelledRef.current) setUsageLoading(false);
      }
    },
    [id, weekStart]
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void loadUsage(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [loadUsage]);

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
        <EmptyState tone="error" title={t("subscriptions.detail.loadError")} actionLabel={t("subscriptions.retry")} onAction={() => void load()} isRTL={isRTL} />
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

  // Lifetime reconciliation for this one subscription: every currently-effective charge
  // (reversals already excluded by currentEffectiveChargeAmount) minus every unreversed
  // payment ever recorded against it. Mirrors manager_subscription_overview_stats's
  // lifetime convention — not period-scoped, since payments aren't allocated to a specific
  // billing period (by design: see subscription payment UX decision).
  const totalCharged = detail.billing_periods.reduce(
    (sum, p) => sum + (currentEffectiveChargeAmount(p.charges) ?? 0),
    0
  );
  const totalPaid = payments.reduce((sum, p) => (p.reversed_at ? sum : sum + p.amount_ils), 0);
  const outstanding = totalCharged - totalPaid;

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

  async function finishDelete(res: { ok: true; action: "preview" | "tombstoned" | "already_deleted"; future_registrations?: FutureRegistrationItem[] }) {
    if (res.action === "preview") {
      setFutureRegs(res.future_registrations ?? []);
      setFutureRegsNotice(undefined);
      setFutureRegsOpen(true);
      return;
    }
    setFutureRegsOpen(false);
    showToast({ message: t("subscriptions.delete.success"), variant: "success" });
    router.replace("/(app)/manager/subscriptions");
  }

  // First call: previews (p_confirmed=false). A subscription with nothing upcoming never gets a
  // "preview" back and deletes in this single round trip -- no extra step added for the common case.
  async function runDelete() {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      const res = await rpcDeleteSubscription(supabase, String(id), false, null);
      if (!res.ok) {
        if (res.error === "subscription_has_payments") {
          showToast({ message: t("subscriptions.delete.blockedByPayments"), variant: "error" });
        } else {
          showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        }
        return;
      }
      await finishDelete(res);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  // Second call, from the future-registrations choice dialog: always confirmed, with the chosen action.
  async function confirmDeleteWithFutureAction(action: FutureRegistrationAction) {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      const res = await rpcDeleteSubscription(supabase, String(id), true, action, futureRegs);
      if (!res.ok) {
        // See StopSubscriptionForm's identical handling: the list changed since preview (or the
        // staleness check was never satisfied) -- refresh it from this same response and require an
        // explicit new review + confirm, never a silent retry.
        if (res.error === "future_registrations_changed" || res.error === "future_registrations_expectation_required") {
          setFutureRegs(res.future_registrations ?? []);
          setFutureRegsNotice(t("subscriptions.futureRegs.changed"));
          setFutureRegsOpen(true);
          return;
        }
        showToast({ message: t("subscriptions.genericError"), detail: res.error, variant: "error" });
        return;
      }
      await finishDelete(res);
    } catch (e) {
      showToast({ message: t("subscriptions.genericError"), detail: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, screenContent]}>
        <Text style={[styles.title, isRTL && styles.rtl]}>{payeeName || t("subscriptions.detail.title")}</Text>

        <Section title={t("subscriptions.detail.overview")} isRTL={isRTL}>
          <KeyValue label={t("subscriptions.detail.price")} value={displayMoney(current?.monthly_price_ils ?? 0)} isRTL={isRTL} />
          <KeyValue label={t("subscriptions.detail.totalCharged")} value={displayMoney(totalCharged)} isRTL={isRTL} />
          <KeyValue label={t("subscriptions.detail.totalPaid")} value={displayMoney(totalPaid)} isRTL={isRTL} />
          <KeyValue label={t("subscriptions.detail.outstandingBalance")} value={displayMoney(outstanding)} isRTL={isRTL} />
          <KeyValue label={t("subscriptions.rowStart")} value={formatISODateFull(current?.plan_start_date ?? "", language)} isRTL={isRTL} />
          <KeyValue
            label={t("subscriptions.rowEnd")}
            value={
              current?.has_no_end_date || !current?.effective_plan_end_date
                ? t("subscriptions.noEndDate")
                : formatISODateFull(current.effective_plan_end_date, language)
            }
            isRTL={isRTL}
          />
          {detail.next_billing_date ? (
            <KeyValue label={t("subscriptions.rowNextBilling")} value={formatISODateFull(detail.next_billing_date, language)} isRTL={isRTL} />
          ) : null}
          <KeyValue label={t("subscriptions.detail.anchorDay")} value={t("subscriptions.detail.anchorDayValue").replace("{day}", String(current?.anchor_day ?? ""))} isRTL={isRTL} />
          {terms ? (
            <KeyValue
              label={t("subscriptions.terms.label")}
              value={managerTermsStatusText(terms, t, (iso) => formatISODateFull(iso, language))}
              isRTL={isRTL}
            />
          ) : null}
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

        <View style={styles.section}>
          <View style={[styles.weekNavRow, rowFlipFor(isRTL) && styles.weekNavRowRtl]}>
            <Text style={[styles.sectionTitle, isRTL && styles.rtl]}>{t("subscriptions.detail.usageTitle")}</Text>
            <View style={[styles.weekNav, rowFlipFor(isRTL) && styles.weekNavRtl]}>
              <Pressable
                onPress={() => setWeekOffset((w) => w - 1)}
                style={styles.weekNavBtn}
                accessibilityRole="button"
                accessibilityLabel={t("dashboard.a11yPrevWeek")}
              >
                <Text style={styles.weekNavChevron}>{isRTL ? "→" : "←"}</Text>
              </Pressable>
              <Text style={styles.weekNavLabel} numberOfLines={1}>
                {t("athleteSubscription.weekRange")
                  .replace("{from}", formatISODateDayMonth(weekStart, language))
                  .replace("{to}", formatISODateDayMonth(weekBoundsSunday(weekStart).end, language))}
              </Text>
              <Pressable
                onPress={() => setWeekOffset((w) => w + 1)}
                style={styles.weekNavBtn}
                accessibilityRole="button"
                accessibilityLabel={t("dashboard.a11yNextWeek")}
              >
                <Text style={styles.weekNavChevron}>{isRTL ? "←" : "→"}</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.sectionBody}>
            {usageLoading ? (
              <ActivityIndicator color={theme.colors.cta} style={styles.usageSpinner} />
            ) : usageError ? (
              <Text style={[styles.historyLine, isRTL && styles.rtl]}>{t("subscriptions.detail.usageLoadError")}</Text>
            ) : !usage || usage.usage.length === 0 ? (
              <Text style={[styles.historyLine, isRTL && styles.rtl]}>{t("subscriptions.detail.noUsage")}</Text>
            ) : (
              usage.usage.map((row, idx) => {
                const tierUsage = tierUsageFromRow(row);
                return (
                  <View key={tierUsage.tier} style={idx > 0 ? styles.meterRowDivider : undefined}>
                    <WeeklyAllowanceMeter
                      title={t(tierLabelKey(tierUsage.tier))}
                      used={tierUsage.used}
                      limit={tierUsage.weeklyLimit}
                      usedLabel={usedOfLimitLabel(tierUsage.used, tierUsage.weeklyLimit, t)}
                      statusLabel={tierUsage.exhausted ? t("athleteSubscription.allowanceUsedUp") : sessionsLeftLabel(tierUsage.remaining, t)}
                      noteLabel={tierUsage.extra > 0 ? extraSessionsLabel(tierUsage.extra, t) : undefined}
                      exhausted={tierUsage.exhausted}
                      isRTL={isRTL}
                    />
                  </View>
                );
              })
            )}
          </View>
        </View>

        <Section title={t("subscriptions.detail.versionHistoryTitle")} isRTL={isRTL}>
          {versions.map((v) => (
            <Text key={v.id} style={[styles.historyLine, isRTL && styles.rtl]}>
              {t("subscriptions.detail.versionLine")
                .replace("{start}", formatISODateFull(v.effective_from, language))
                .replace("{end}", v.effective_to ? formatISODateFull(v.effective_to, language) : t("subscriptions.detail.versionOngoing"))
                .replace("{price}", displayMoney(v.monthly_price_ils))}
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
                  {amount != null ? `: ${displayMoney(amount)}` : ""}
                </Text>
              );
            })
          )}
        </Section>

        <Section title={t("subscriptions.payment.historyTitle")} isRTL={isRTL}>
          {payments.length === 0 ? (
            <Text style={[styles.historyLine, isRTL && styles.rtl]}>{t("subscriptions.payment.noPayments")}</Text>
          ) : (
            payments.map((p) => (
              <View key={p.id} style={[styles.kv, rowFlipFor(isRTL) && styles.kvRtl]}>
                <Text style={[styles.historyLine, isRTL && styles.rtl]} numberOfLines={1}>
                  {formatISODateFull(p.paid_at, language)} · {paymentMethodHistoryLabel(p.payment_method, language)}
                  {p.reversed_at ? ` (${t("subscriptions.payment.reversed")})` : ""}
                </Text>
                <Text style={[styles.kvValue, isRTL && styles.rtl]}>{displayMoney(p.amount_ils)}</Text>
              </View>
            ))
          )}
          {!isTombstoned ? (
            <PrimaryButton
              label={t("subscriptions.payment.recordAction")}
              onPress={() => setPaymentModalOpen(true)}
              variant="ghost"
              style={styles.recordPaymentBtn}
            />
          ) : null}
        </Section>

        <Section title={t("subscriptions.detail.actionsTitle")} isRTL={isRTL}>
          <View style={styles.actions}>
            {!isTombstoned && isActiveGroup ? (
              <>
                <PrimaryButton
                  label={t("subscriptions.action.edit")}
                  onPress={() => router.push(`/(app)/manager/subscriptions/${id}/edit`)}
                  variant="ghost"
                  style={styles.actionBtn}
                />
                <PrimaryButton
                  label={t("subscriptions.action.freeze")}
                  onPress={() => router.push(`/(app)/manager/subscriptions/${id}/freeze`)}
                  variant="ghost"
                  style={styles.actionBtn}
                />
                <PrimaryButton
                  label={t("subscriptions.action.stop")}
                  onPress={() => router.push(`/(app)/manager/subscriptions/${id}/stop`)}
                  variant="ghost"
                  style={styles.actionBtn}
                />
              </>
            ) : null}
            {!isTombstoned && !isActiveGroup ? (
              <PrimaryButton
                label={t("subscriptions.action.reactivate")}
                onPress={() => router.push(`/(app)/manager/subscriptions/${id}/reactivate`)}
                variant="ghost"
                style={styles.actionBtn}
              />
            ) : null}
            {!isTombstoned ? (
              <PrimaryButton label={t("subscriptions.action.delete")} onPress={requestDelete} loading={deleting} variant="danger" style={styles.actionBtn} />
            ) : null}
          </View>
        </Section>
      </ScrollView>
      <AddSubscriptionPaymentModal
        visible={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        subscriptionId={String(id)}
        payeeLabel={payeeName}
        defaultAmountIls={current?.monthly_price_ils ?? 0}
        outstandingIls={outstanding}
        onSaved={loadPayments}
      />
      <FutureRegistrationsChoiceModal
        visible={futureRegsOpen}
        items={futureRegs}
        busy={deleting}
        notice={futureRegsNotice}
        onCancel={() => {
          setFutureRegsOpen(false);
          setFutureRegsNotice(undefined);
        }}
        onConfirm={(action) => void confirmDeleteWithFutureAction(action)}
      />
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
    <View style={[styles.kv, rowFlipFor(isRTL) && styles.kvRtl]}>
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
  title: { fontSize: 20, fontWeight: "800", color: theme.colors.text, marginBottom: theme.spacing.md },
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  sectionTitle: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", marginBottom: theme.spacing.sm },
  weekNavRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.spacing.sm },
  weekNavRowRtl: { flexDirection: "row-reverse" },
  weekNav: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs },
  weekNavRtl: { flexDirection: "row-reverse" },
  weekNavBtn: { padding: 4 },
  weekNavChevron: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  weekNavLabel: { fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, minWidth: 92, textAlign: "center" },
  usageSpinner: { paddingVertical: theme.spacing.sm },
  meterRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderMuted },
  sectionBody: { gap: 6 },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm },
  kvRtl: { flexDirection: "row-reverse" },
  kvLabel: { ...theme.typography.caption, color: theme.colors.textMuted },
  kvValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text, flexShrink: 1 },
  allowanceLine: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  historyLine: { ...theme.typography.caption, color: theme.colors.textMuted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  actionBtn: { flexGrow: 1, minWidth: 120 },
  recordPaymentBtn: { marginTop: theme.spacing.sm },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
