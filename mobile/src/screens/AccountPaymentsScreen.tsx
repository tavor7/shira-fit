import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter, type Href } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useToast } from "../context/ToastContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { ReportDateRangeControls } from "../components/ReportDateRangeControls";
import { AppSearchField } from "../components/AppSearchField";
import { AppModal } from "../components/AppModal";
import { AddAccountPaymentModal } from "../components/AddAccountPaymentModal";
import { PrimaryButton } from "../components/PrimaryButton";
import { formatISODateFullWithWeekdayAfter } from "../lib/dateFormat";
import { formatSessionTimeShort } from "../lib/financeBreakdownFormat";
import { lastNDaysRangeISO } from "../lib/isoDate";
import { parseStaffReceivedPayments, type StaffReceivedPaymentRow } from "../lib/staffReceivedPayments";
import {
  paymentMethodHistoryLabel,
  SESSION_PAYMENT_METHOD_KEYS,
  type SessionPaymentMethodKey,
} from "../lib/paymentMethod";
import { type FamilyMemberKind, memberPayeeKey, parseFamilyMembers } from "../lib/athleteFamilies";
import type { AthleteAccountPayment } from "../types/database";

type DateMode = "all" | "range";
type PaymentMethodFilter = "all" | SessionPaymentMethodKey;

type PayeeFilter =
  | { type: "all" }
  | { type: "app"; id: string; label: string }
  | { type: "manual"; id: string; label: string }
  | {
      type: "family";
      id: string;
      label: string;
      members: { kind: FamilyMemberKind; id: string; name: string | null }[];
    };

type PaymentRow = StaffReceivedPaymentRow & {
  payee_label: string;
  payee_kind: "app" | "manual";
  family_name: string | null;
  created_by_name: string | null;
};

type PickerRow =
  | { kind: "app"; id: string; full_name: string; username?: string; phone?: string }
  | { kind: "manual"; id: string; full_name: string; phone?: string; linked_user_id?: string | null }
  | {
      kind: "family";
      id: string;
      name: string;
      member_count: number;
      members: { kind: FamilyMemberKind; id: string; name: string | null }[];
    };

function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function payeeFilterLabel(filter: PayeeFilter, t: (k: string) => string): string {
  if (filter.type === "all") return t("accountPayments.allPayees");
  return filter.label;
}

export default function AccountPaymentsScreen() {
  const router = useRouter();
  const { language, t, isRTL } = useI18n();
  const { showConfirm } = useAppAlert();
  const { showToast } = useToast();
  const rtlRow = isRTL;

  const defaultRange = useMemo(() => lastNDaysRangeISO(30), []);
  const [dateMode, setDateMode] = useState<DateMode>("all");
  const [dateStart, setDateStart] = useState(defaultRange.start);
  const [dateEnd, setDateEnd] = useState(defaultRange.end);
  const [payeeFilter, setPayeeFilter] = useState<PayeeFilter>({ type: "all" });
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<PaymentMethodFilter>("all");

  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [totalReceived, setTotalReceived] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [payeePickerOpen, setPayeePickerOpen] = useState(false);
  const [payeePickerMode, setPayeePickerMode] = useState<"filter" | "add">("filter");
  const [pickerQ, setPickerQ] = useState("");
  const [pickerRows, setPickerRows] = useState<PickerRow[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const [memberPickOpen, setMemberPickOpen] = useState(false);
  const [addPayOpen, setAddPayOpen] = useState(false);
  const [editPayment, setEditPayment] = useState<AthleteAccountPayment | null>(null);
  const [addPayee, setAddPayee] = useState<{ id: string; isManual: boolean; label: string; showPayerName: boolean } | null>(
    null
  );

  const loadPayments = useCallback(async () => {
    const rpcArgs: Record<string, unknown> = {
      p_limit: 500,
      p_offset: 0,
    };

    if (dateMode === "range") {
      rpcArgs.p_date_start = dateStart;
      rpcArgs.p_date_end = dateEnd;
    }

    if (payeeFilter.type === "app") {
      rpcArgs.p_payee_id = payeeFilter.id;
      rpcArgs.p_payee_is_manual = false;
    } else if (payeeFilter.type === "manual") {
      rpcArgs.p_payee_id = payeeFilter.id;
      rpcArgs.p_payee_is_manual = true;
    } else if (payeeFilter.type === "family") {
      rpcArgs.p_payee_filters = payeeFilter.members.map((m) => ({
        id: m.id,
        is_manual: m.kind === "manual",
      }));
    }

    if (paymentMethodFilter !== "all") {
      rpcArgs.p_payment_method = paymentMethodFilter;
    }

    const { data, error } = await supabase.rpc("staff_list_received_payments", rpcArgs);
    if (error) {
      showToast({ message: t("common.error"), detail: error.message, variant: "error" });
      setRows([]);
      setTotalReceived(0);
      setTotalCount(0);
      return;
    }

    const payload = parseStaffReceivedPayments(data);
    if (!payload.ok) {
      showToast({
        message: t("common.error"),
        detail: payload.error ?? "staff_list_received_payments",
        variant: "error",
      });
      setRows([]);
      setTotalReceived(0);
      setTotalCount(0);
      return;
    }

    const payRows = payload.payments;
    const appIds = [...new Set(payRows.filter((p) => !p.payee_is_manual).map((p) => p.payee_id))];
    const manualIds = [...new Set(payRows.filter((p) => p.payee_is_manual).map((p) => p.payee_id))];
    const staffIds = [...new Set(payRows.map((p) => p.created_by).filter((id): id is string => !!id))];

    const [profilesRes, manualRes, familiesRes, staffRes] = await Promise.all([
      appIds.length > 0
        ? supabase.from("profiles").select("user_id, full_name, username").in("user_id", appIds)
        : Promise.resolve({ data: [] as { user_id: string; full_name: string; username: string | null }[] }),
      manualIds.length > 0
        ? supabase.from("manual_participants").select("id, full_name").in("id", manualIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      supabase.rpc("list_athlete_families"),
      staffIds.length > 0
        ? supabase.from("profiles").select("user_id, full_name").in("user_id", staffIds)
        : Promise.resolve({ data: [] as { user_id: string; full_name: string }[] }),
    ]);

    const profileLabels = Object.fromEntries(
      (profilesRes.data ?? []).map((p) => [
        p.user_id,
        `${(p.full_name ?? "").trim()}${p.username ? ` (@${p.username})` : ""}`.trim() || p.user_id.slice(0, 8),
      ])
    );
    const manualLabels = Object.fromEntries(
      (manualRes.data ?? []).map((m) => [m.id, (m.full_name ?? "").trim() || m.id.slice(0, 8)])
    );
    const staffNames = Object.fromEntries(
      (staffRes.data ?? []).map((p) => [p.user_id, (p.full_name ?? "").trim()])
    );

    const memberToFamily = new Map<string, string>();
    const famPayload = familiesRes.data as { ok?: boolean; families?: unknown[] } | null;
    if (famPayload?.ok && Array.isArray(famPayload.families)) {
      for (const raw of famPayload.families) {
        if (!raw || typeof raw !== "object") continue;
        const f = raw as Record<string, unknown>;
        const fname = typeof f.name === "string" ? f.name : null;
        if (!fname) continue;
        for (const m of parseFamilyMembers(f.members)) {
          memberToFamily.set(memberPayeeKey(m.kind, m.id), fname);
        }
      }
    }
    if (payeeFilter.type === "family") {
      for (const m of payeeFilter.members) {
        memberToFamily.set(memberPayeeKey(m.kind, m.id), payeeFilter.label);
      }
    }

    setRows(
      payRows.map((p) => {
        const key = memberPayeeKey(p.payee_is_manual ? "manual" : "app", p.payee_id);
        return {
          ...p,
          payee_kind: p.payee_is_manual ? "manual" : "app",
          payee_label: p.payee_is_manual
            ? manualLabels[p.payee_id] ?? p.payee_id.slice(0, 8)
            : profileLabels[p.payee_id] ?? p.payee_id.slice(0, 8),
          family_name: memberToFamily.get(key) ?? null,
          created_by_name: p.created_by ? staffNames[p.created_by] ?? null : null,
        };
      })
    );
    setTotalReceived(payload.total_received);
    setTotalCount(payload.total_count);
  }, [dateMode, dateStart, dateEnd, payeeFilter, paymentMethodFilter, showToast, t]);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      await loadPayments();
      if (!opts?.silent) setLoading(false);
      setRefreshing(false);
    },
    [loadPayments]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void reload({ silent: true });
  }, [reload]);

  function sessionSlotLabel(kind: PaymentRow["session_slot_kind"]): string {
    if (kind === "arrival") return t("accountPayments.sessionArrival");
    if (kind === "no_show") return t("accountPayments.sessionNoShow");
    if (kind === "cancellation") return t("accountPayments.sessionLateCancel");
    return t("accountPayments.sessionPayment");
  }

  function openSessionPayment(item: PaymentRow) {
    if (!item.session_id) return;
    router.push(`/(app)/manager/session/${item.session_id}` as Href);
  }

  const loadPickerRows = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setPickerLoading(true);

    let profileQuery = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(80);
    if (q) profileQuery = profileQuery.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);

    let manualQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .order("full_name", { ascending: true })
      .limit(80);
    if (q) manualQuery = manualQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);

    const [profilesRes, manualRes, familiesRes] = await Promise.all([
      profileQuery,
      manualQuery,
      supabase.rpc("list_athlete_families"),
    ]);

    const athletes: PickerRow[] = (
      (profilesRes.data ?? []) as { user_id: string; full_name: string; username?: string; phone?: string }[]
    ).map((p) => ({
      kind: "app" as const,
      id: p.user_id,
      full_name: p.full_name,
      username: p.username,
      phone: p.phone,
    }));

    const manuals: PickerRow[] = ((manualRes.data ?? []) as { id: string; full_name: string; phone?: string; linked_user_id?: string | null }[]).map(
      (m) => ({ kind: "manual" as const, ...m })
    );

    const families: PickerRow[] = [];
    const famPayload = familiesRes.data as { ok?: boolean; families?: unknown[] } | null;
    if (famPayload?.ok && Array.isArray(famPayload.families)) {
      for (const raw of famPayload.families) {
        if (!raw || typeof raw !== "object") continue;
        const f = raw as Record<string, unknown>;
        const id = typeof f.id === "string" ? f.id : null;
        const name = typeof f.name === "string" ? f.name : null;
        if (!id || !name) continue;
        if (q && !name.toLowerCase().includes(q.toLowerCase())) continue;
        const members = parseFamilyMembers(f.members).map((m) => ({
          kind: m.kind,
          id: m.id,
          name: m.name,
        }));
        families.push({ kind: "family", id, name, member_count: members.length, members });
      }
    }

    setPickerLoading(false);
    if (profilesRes.error) {
      setPickerRows([]);
      return;
    }
    setPickerRows([...families, ...manuals.filter((m) => !m.linked_user_id), ...athletes]);
  }, []);

  useEffect(() => {
    if (!payeePickerOpen) return;
    void loadPickerRows(pickerQ);
  }, [payeePickerOpen, pickerQ, loadPickerRows]);

  function openPayeePicker(mode: "filter" | "add") {
    setPayeePickerMode(mode);
    setPickerQ("");
    setPayeePickerOpen(true);
  }

  function applyPickerRow(row: PickerRow) {
    setPayeePickerOpen(false);
    if (row.kind === "family") {
      const filter: PayeeFilter = {
        type: "family",
        id: row.id,
        label: row.name,
        members: row.members,
      };
      if (payeePickerMode === "filter") {
        setPayeeFilter(filter);
        return;
      }
      if (row.members.length === 1) {
        const m = row.members[0];
        const label = row.name;
        setAddPayee({
          id: m.id,
          isManual: m.kind === "manual",
          label,
          showPayerName: true,
        });
        setEditPayment(null);
        setAddPayOpen(true);
        return;
      }
      setPayeeFilter(filter);
      setMemberPickOpen(true);
      return;
    }

    const isManual = row.kind === "manual";
    const id = row.id;
    const label =
      row.kind === "app"
        ? `${row.full_name}${row.username ? ` (@${row.username})` : ""}`
        : `${row.full_name}${row.phone ? ` · ${row.phone}` : ""}`;

    if (payeePickerMode === "filter") {
      setPayeeFilter(isManual ? { type: "manual", id, label } : { type: "app", id, label });
      return;
    }

    setAddPayee({ id, isManual, label, showPayerName: false });
    setEditPayment(null);
    setAddPayOpen(true);
  }

  function onAddPayment() {
    if (payeeFilter.type === "all") {
      openPayeePicker("add");
      return;
    }
    if (payeeFilter.type === "family") {
      if (payeeFilter.members.length === 1) {
        const m = payeeFilter.members[0];
        setAddPayee({
          id: m.id,
          isManual: m.kind === "manual",
          label: payeeFilter.label,
          showPayerName: true,
        });
        setEditPayment(null);
        setAddPayOpen(true);
        return;
      }
      setMemberPickOpen(true);
      return;
    }
    setAddPayee({
      id: payeeFilter.id,
      isManual: payeeFilter.type === "manual",
      label: payeeFilter.label,
      showPayerName: false,
    });
    setEditPayment(null);
    setAddPayOpen(true);
  }

  function confirmDelete(paymentId: string) {
    showConfirm({
      title: language === "he" ? "אישור" : "Confirm",
      message: t("billing.deletePaymentConfirm"),
      cancelLabel: t("common.cancel"),
      confirmLabel: t("billing.deletePayment"),
      confirmVariant: "danger",
      onConfirm: () => {
        void (async () => {
          setDeletingId(paymentId);
          const { error } = await supabase.from("athlete_account_payments").delete().eq("id", paymentId);
          setDeletingId(null);
          if (error) {
            showToast({ message: t("common.error"), detail: error.message, variant: "error" });
            return;
          }
          showToast({ message: t("billing.paymentDeleted"), variant: "success" });
          await reload({ silent: true });
        })();
      },
    });
  }

  function openAccountPaymentEdit(item: PaymentRow) {
    setAddPayee({
      id: item.payee_id,
      isManual: item.payee_is_manual,
      label: item.payee_label,
      showPayerName: !!item.family_name || !!item.payer_name,
    });
    setEditPayment({
      id: item.record_id,
      payee_id: item.payee_id,
      payee_is_manual: item.payee_is_manual,
      amount_ils: item.amount_ils,
      payment_method: item.payment_method ?? "",
      note: item.note,
      payer_name: item.payer_name,
      paid_at: item.paid_at,
      created_at: item.created_at,
      created_by: item.created_by,
    });
    setAddPayOpen(true);
  }

  const dateModeOptions: { id: DateMode; label: string }[] = [
    { id: "all", label: t("accountPayments.allDates") },
    { id: "range", label: t("accountPayments.dateRange") },
  ];

  const paymentMethodOptions: { id: PaymentMethodFilter; label: string }[] = [
    { id: "all", label: t("accountPayments.allMethods") },
    ...SESSION_PAYMENT_METHOD_KEYS.map((key) => ({
      id: key as PaymentMethodFilter,
      label: paymentMethodHistoryLabel(key, language),
    })),
  ];

  const listHeader = (
    <View style={styles.headerBlock}>
      <ManagerStudioSetupTabs />
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.accountPayments")}</Text>
      <Text style={[styles.hint, isRTL && styles.rtl]}>{t("accountPayments.subtitle")}</Text>

      <View style={styles.filterCard}>
        <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>{t("accountPayments.payeeFilter")}</Text>
        <Pressable
          style={({ pressed }) => [styles.pickerTouch, pressed && styles.pickerTouchPressed]}
          onPress={() => openPayeePicker("filter")}
        >
          <Text style={[payeeFilter.type === "all" ? styles.pickerPlaceholder : styles.pickerText, isRTL && styles.rtl]} numberOfLines={2}>
            {payeeFilterLabel(payeeFilter, t)}
          </Text>
        </Pressable>
        {payeeFilter.type !== "all" ? (
          <Pressable
            style={({ pressed }) => [styles.clearLink, pressed && { opacity: 0.85 }]}
            onPress={() => setPayeeFilter({ type: "all" })}
          >
            <Text style={[styles.clearLinkText, isRTL && styles.rtl]}>{t("common.clearSelection")}</Text>
          </Pressable>
        ) : null}

        <Text style={[styles.sectionLabel, styles.sectionSpaced, isRTL && styles.rtl]}>{t("accountPayments.dateFilter")}</Text>
        <View style={[styles.dateModeRow, rtlRow && styles.dateModeRowRtl]}>
          {dateModeOptions.map((opt) => {
            const on = dateMode === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => setDateMode(opt.id)}
                style={({ pressed }) => [styles.dateModeChip, on && styles.dateModeChipOn, pressed && !on && { opacity: 0.9 }]}
              >
                <Text style={[styles.dateModeChipText, on && styles.dateModeChipTextOn]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {dateMode === "range" ? (
          <View style={styles.dateRangeWrap}>
            <ReportDateRangeControls
              start={dateStart}
              end={dateEnd}
              onChange={({ start, end }) => {
                setDateStart(start);
                setDateEnd(end);
              }}
            />
          </View>
        ) : null}

        <Text style={[styles.sectionLabel, styles.sectionSpaced, isRTL && styles.rtl]}>{t("accountPayments.methodFilter")}</Text>
        <View style={[styles.methodChipRow, rtlRow && styles.methodChipRowRtl]}>
          {paymentMethodOptions.map((opt) => {
            const on = paymentMethodFilter === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => setPaymentMethodFilter(opt.id)}
                style={({ pressed }) => [styles.methodChip, on && styles.methodChipOn, pressed && !on && { opacity: 0.9 }]}
              >
                <Text style={[styles.methodChipText, on && styles.methodChipTextOn]} numberOfLines={1}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.summaryRow, rtlRow && styles.summaryRowRtl]}>
          <View style={styles.summaryStat}>
            <Text style={[styles.summaryValue, isRTL && styles.rtl]}>{totalCount}</Text>
            <Text style={[styles.summaryLabel, isRTL && styles.rtl]}>{t("accountPayments.paymentCount")}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryStat}>
            <Text style={[styles.summaryValue, isRTL && styles.rtl]}>{`${Math.round(totalReceived * 100) / 100} ₪`}</Text>
            <Text style={[styles.summaryLabel, isRTL && styles.rtl]}>{t("billing.received")}</Text>
          </View>
        </View>

        <PrimaryButton label={t("billing.addPayment")} onPress={onAddPayment} style={styles.addBtn} />
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(item) => item.row_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.cta} />}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.listLoading} color={theme.colors.cta} />
          ) : (
            <Text style={[styles.empty, isRTL && styles.rtl]}>{t("accountPayments.empty")}</Text>
          )
        }
        renderItem={({ item }) => {
          const amt = parseMoney(item.amount_ils);
          const amtTxt = amt !== null && amt > 0 ? `${amt} ₪` : "—";
          const busy = deletingId === item.record_id;
          const isAccount = item.source === "account";
          const kindLabel =
            item.payee_kind === "manual" ? t("accountPayments.kindManual") : t("accountPayments.kindAthlete");
          const sessionMeta =
            item.source === "session" && item.session_date
              ? `${sessionSlotLabel(item.session_slot_kind)} · ${formatISODateFullWithWeekdayAfter(item.session_date, language)}${
                  item.session_start_time ? ` · ${formatSessionTimeShort(item.session_start_time)}` : ""
                }`
              : null;
          return (
            <View style={styles.paymentCard}>
              <View style={[styles.paymentHead, rtlRow && styles.paymentHeadRtl]}>
                <Text style={[styles.paymentDate, isRTL && styles.rtl]} numberOfLines={2}>
                  {formatISODateFullWithWeekdayAfter(item.paid_at, language)}
                </Text>
                <Text style={styles.paymentAmount}>{amtTxt}</Text>
              </View>
              <View style={[styles.payeeRow, rtlRow && styles.payeeRowRtl]}>
                <Text style={[styles.payeeName, isRTL && styles.rtl]} numberOfLines={1}>
                  {item.payee_label}
                </Text>
                <View style={styles.kindBadge}>
                  <Text style={styles.kindBadgeText}>{kindLabel}</Text>
                </View>
              </View>
              {item.family_name ? (
                <Text style={[styles.metaLine, isRTL && styles.rtl]} numberOfLines={1}>
                  {language === "he" ? "משפחה" : "Family"}: {item.family_name}
                </Text>
              ) : null}
              {sessionMeta ? (
                <Text style={[styles.metaLine, isRTL && styles.rtl]} numberOfLines={2}>
                  {sessionMeta}
                </Text>
              ) : null}
              <Text style={[styles.metaLine, isRTL && styles.rtl]} numberOfLines={1}>
                {item.payment_method
                  ? paymentMethodHistoryLabel(item.payment_method, language)
                  : t("accountPayments.methodUnknown")}
                {(item.note ?? "").trim() ? ` · ${item.note}` : ""}
              </Text>
              {item.payer_name?.trim() ? (
                <Text style={[styles.metaLine, isRTL && styles.rtl]} numberOfLines={1}>
                  {t("families.paidBy").replace("{name}", item.payer_name.trim())}
                </Text>
              ) : null}
              {item.created_by_name ? (
                <Text style={[styles.footnote, isRTL && styles.rtl]} numberOfLines={1}>
                  {t("participantHistory.reportedBy").replace("{name}", item.created_by_name.split(/\s+/)[0] ?? item.created_by_name)}
                </Text>
              ) : null}
              <View style={[styles.actionBar, rtlRow && styles.actionBarRtl]}>
                {isAccount ? (
                  <>
                    <Pressable
                      onPress={() => openAccountPaymentEdit(item)}
                      disabled={busy}
                      style={({ pressed }) => [styles.actionItem, pressed && !busy && styles.actionItemPressed]}
                    >
                      <Text style={[styles.actionText, isRTL && styles.rtl]}>{t("participantHistory.editShort")}</Text>
                    </Pressable>
                    <View style={styles.actionSep} />
                    <Pressable
                      onPress={() => confirmDelete(item.record_id)}
                      disabled={busy}
                      style={({ pressed }) => [styles.actionItem, styles.actionItemDanger, pressed && !busy && styles.actionItemPressed]}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={theme.colors.error} />
                      ) : (
                        <Text style={[styles.actionTextDanger, isRTL && styles.rtl]}>{t("participantHistory.removeShort")}</Text>
                      )}
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={() => openSessionPayment(item)}
                    style={({ pressed }) => [styles.actionItem, styles.actionItemWide, pressed && styles.actionItemPressed]}
                  >
                    <Text style={[styles.actionText, isRTL && styles.rtl]}>{t("accountPayments.openSession")}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        }}
      />

      <AppModal
        visible={payeePickerOpen}
        onClose={() => setPayeePickerOpen(false)}
        variant="sheet"
        backdropAccessibilityLabel={t("common.cancel")}
        cardStyle={styles.pickerSheet}
      >
        <View style={[styles.pickerHeader, rtlRow && styles.pickerHeaderRtl]}>
          <Text style={[styles.pickerTitle, isRTL && styles.rtl]}>
            {payeePickerMode === "add" ? t("accountPayments.pickPayeeAdd") : t("accountPayments.pickPayeeFilter")}
          </Text>
          <Pressable onPress={() => setPayeePickerOpen(false)} hitSlop={12}>
            <Text style={styles.pickerClose}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
        <View style={styles.pickerBody}>
          <AppSearchField value={pickerQ} onChangeText={setPickerQ} placeholder={t("accountPayments.searchPayees")} />
          {pickerLoading ? (
            <ActivityIndicator style={styles.pickerLoading} color={theme.colors.cta} />
          ) : (
            <FlatList
              data={pickerRows}
              keyExtractor={(r) => `${r.kind}:${r.id}`}
              keyboardShouldPersistTaps="handled"
              style={styles.pickerList}
              ListEmptyComponent={<Text style={[styles.empty, isRTL && styles.rtl]}>{t("accountPayments.noPayees")}</Text>}
              renderItem={({ item }) => {
                let subtitle = "";
                let title = "";
                if (item.kind === "family") {
                  title = item.name;
                  subtitle = t("accountPayments.familyMembers").replace("{n}", String(item.member_count));
                } else if (item.kind === "manual") {
                  title = item.full_name;
                  subtitle = t("accountPayments.kindManual");
                } else {
                  title = item.full_name;
                  subtitle = item.username ? `@${item.username}` : t("accountPayments.kindAthlete");
                }
                return (
                  <Pressable
                    style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
                    onPress={() => applyPickerRow(item)}
                  >
                    <Text style={[styles.pickerRowTitle, isRTL && styles.rtl]} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={[styles.pickerRowSub, isRTL && styles.rtl]} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      </AppModal>

      <AppModal
        visible={memberPickOpen}
        onClose={() => setMemberPickOpen(false)}
        variant="sheet"
        backdropAccessibilityLabel={t("common.cancel")}
        cardStyle={styles.pickerSheet}
      >
        <View style={[styles.pickerHeader, rtlRow && styles.pickerHeaderRtl]}>
          <Text style={[styles.pickerTitle, isRTL && styles.rtl]}>{t("accountPayments.pickMember")}</Text>
          <Pressable onPress={() => setMemberPickOpen(false)} hitSlop={12}>
            <Text style={styles.pickerClose}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
        <View style={styles.pickerBody}>
          {payeeFilter.type === "family"
            ? payeeFilter.members.map((m) => (
                <Pressable
                  key={memberPayeeKey(m.kind, m.id)}
                  style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
                  onPress={() => {
                    setMemberPickOpen(false);
                    setAddPayee({
                      id: m.id,
                      isManual: m.kind === "manual",
                      label: m.name?.trim() || payeeFilter.label,
                      showPayerName: true,
                    });
                    setEditPayment(null);
                    setAddPayOpen(true);
                  }}
                >
                  <Text style={[styles.pickerRowTitle, isRTL && styles.rtl]} numberOfLines={1}>
                    {m.name?.trim() || (m.kind === "manual" ? t("accountPayments.kindManual") : t("accountPayments.kindAthlete"))}
                  </Text>
                  <Text style={[styles.pickerRowSub, isRTL && styles.rtl]}>
                    {m.kind === "manual" ? t("accountPayments.kindManual") : t("accountPayments.kindAthlete")}
                  </Text>
                </Pressable>
              ))
            : null}
        </View>
      </AppModal>

      {addPayee ? (
        <AddAccountPaymentModal
          visible={addPayOpen}
          onClose={() => {
            setAddPayOpen(false);
            setEditPayment(null);
          }}
          payeeId={editPayment?.payee_id ?? addPayee.id}
          payeeIsManual={editPayment?.payee_is_manual ?? addPayee.isManual}
          payeeLabel={addPayee.label}
          editPayment={editPayment}
          showPayerName={addPayee.showPayerName}
          onSaved={() => reload({ silent: true })}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  list: { flex: 1 },
  listContent: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl },
  headerBlock: { paddingTop: theme.spacing.md },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.2,
    marginBottom: theme.spacing.xs,
  },
  hint: {
    fontSize: 14,
    fontWeight: "500",
    color: theme.colors.textMuted,
    lineHeight: 20,
    marginBottom: theme.spacing.md,
  },
  filterCard: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.md,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.35,
    marginBottom: theme.spacing.sm,
  },
  sectionSpaced: { marginTop: theme.spacing.md },
  pickerTouch: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerTouchPressed: { opacity: 0.92 },
  pickerText: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  pickerPlaceholder: { fontSize: 15, fontWeight: "600", color: theme.colors.textSoft },
  clearLink: { alignSelf: "flex-start", marginTop: theme.spacing.sm, paddingVertical: 4 },
  clearLinkText: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted },
  dateModeRow: { flexDirection: "row", gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  dateModeRowRtl: { flexDirection: "row-reverse" },
  dateModeChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
  },
  dateModeChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  dateModeChipText: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted },
  dateModeChipTextOn: { color: theme.colors.ctaText },
  dateRangeWrap: { marginTop: theme.spacing.xs },
  methodChipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  methodChipRowRtl: { flexDirection: "row-reverse" },
  methodChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  methodChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  methodChipText: { fontSize: 12, fontWeight: "800", color: theme.colors.textMuted },
  methodChipTextOn: { color: theme.colors.ctaText },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  summaryRowRtl: { flexDirection: "row-reverse" },
  summaryStat: { flex: 1, alignItems: "center" },
  summaryDivider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.colors.borderMuted },
  summaryValue: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  summaryLabel: { marginTop: 2, fontSize: 11, fontWeight: "700", color: theme.colors.textSoft, textTransform: "uppercase", letterSpacing: 0.25 },
  addBtn: { marginTop: 0 },
  paymentCard: {
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  paymentHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.spacing.sm },
  paymentHeadRtl: { flexDirection: "row-reverse" },
  paymentDate: { flex: 1, fontSize: 14, fontWeight: "800", color: theme.colors.text, lineHeight: 20 },
  paymentAmount: { fontSize: 17, fontWeight: "900", color: theme.colors.text },
  payeeRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  payeeRowRtl: { flexDirection: "row-reverse" },
  payeeName: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.colors.textMuted },
  kindBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  kindBadgeText: { fontSize: 10, fontWeight: "800", color: theme.colors.textSoft, letterSpacing: 0.2 },
  metaLine: { marginTop: 4, fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, lineHeight: 18 },
  footnote: { marginTop: 6, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  actionBar: {
    flexDirection: "row",
    marginTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    paddingTop: theme.spacing.sm,
  },
  actionBarRtl: { flexDirection: "row-reverse" },
  actionItem: { flex: 1, alignItems: "center", paddingVertical: 8 },
  actionItemWide: { flex: 1 },
  actionItemDanger: {},
  actionItemPressed: { opacity: 0.75 },
  actionSep: { width: StyleSheet.hairlineWidth, backgroundColor: theme.colors.borderMuted },
  actionText: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  actionTextDanger: { fontSize: 13, fontWeight: "800", color: theme.colors.error },
  listLoading: { marginVertical: theme.spacing.xl },
  empty: { textAlign: "center", marginVertical: theme.spacing.xl, color: theme.colors.textSoft, fontWeight: "600" },
  rtl: { textAlign: "right" },
  pickerSheet: { maxHeight: "85%" },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  pickerHeaderRtl: { flexDirection: "row-reverse" },
  pickerTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text, flex: 1 },
  pickerClose: { fontSize: 15, fontWeight: "800", color: theme.colors.textMuted },
  pickerBody: { padding: theme.spacing.md, flex: 1, minHeight: 280 },
  pickerList: { marginTop: theme.spacing.sm, maxHeight: 360 },
  pickerLoading: { marginTop: theme.spacing.lg },
  pickerRow: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  pickerRowPressed: { backgroundColor: theme.colors.surfaceElevated },
  pickerRowTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  pickerRowSub: { marginTop: 2, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
});
