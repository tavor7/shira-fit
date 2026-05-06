import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, TextInput, StyleSheet, Platform, Alert, Pressable, FlatList, ActivityIndicator } from "react-native";
import { useLocalSearchParams, usePathname } from "expo-router";
import { theme } from "../theme";
import { PrimaryButton } from "../components/PrimaryButton";
import { DatePickerField } from "../components/DatePickerField";
import { AppModal } from "../components/AppModal";
import { supabase } from "../lib/supabase";
import { formatSessionTimeRange } from "../lib/sessionTime";
import { toISODateLocal, isValidISODateString, parseISODateLocal, firstDayOfMonthISOLocal } from "../lib/isoDate";
import { formatISODateFull } from "../lib/dateFormat";
import type { AthleteAccountPayment, ParticipantHistoryRow } from "../types/database";
import { useI18n } from "../context/I18nContext";
import { normalizePaymentMethodKey, paymentMethodHistoryLabel } from "../lib/paymentMethod";

type HistorySection = { title: string; data: HistoryListItem[] };
type HistoryListItem =
  | { kind: "session"; reg: ParticipantHistoryRow }
  | { kind: "payment"; pay: AthleteAccountPayment };

function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type BillingSummary = {
  received: number;
  expected: number;
  missingRuleCount: number;
  byMethod: { key: string; total: number }[];
  balance: number;
};

function computeBillingSummary(
  regs: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  pricingByCap: Record<number, number>
): BillingSummary {
  const methodTotals = new Map<string, number>();

  function addToMethod(rawMethod: string | null | undefined, amount: number) {
    if (amount <= 0) return;
    let k = normalizePaymentMethodKey(rawMethod);
    if (k === "(none)") k = "other";
    methodTotals.set(k, (methodTotals.get(k) ?? 0) + amount);
  }

  let received = 0;
  for (const r of regs) {
    const amt = parseMoney(r.amount_paid);
    if (amt !== null && amt > 0) {
      received += amt;
      addToMethod(r.payment_method, amt);
    }
  }
  for (const p of payments) {
    const amt = parseMoney(p.amount_ils);
    if (amt !== null && amt > 0) {
      received += amt;
      addToMethod(p.payment_method, amt);
    }
  }

  let expected = 0;
  let missingRuleCount = 0;
  for (const r of regs) {
    const cap = typeof r.max_participants === "number" ? r.max_participants : null;
    const owes =
      (r.reg_status === "active" && r.attended === true) ||
      (r.reg_status === "cancelled" && r.cancellation_within_24h === true);
    if (!owes || cap === null || cap <= 0) continue;
    const price = pricingByCap[cap];
    if (price === undefined) missingRuleCount += 1;
    else expected += price;
  }

  const byMethod = Array.from(methodTotals.entries())
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);

  return { received, expected, missingRuleCount, byMethod, balance: expected - received };
}

function mergedHistorySections(
  rows: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  athleteLabel: string
): HistorySection[] {
  const title =
    rows.length > 0 ? `${rows[0]!.athlete_name} · ${rows[0]!.athlete_phone}` : athleteLabel.trim() || "—";
  const data: HistoryListItem[] = [
    ...payments.map((pay) => ({ kind: "payment" as const, pay })),
    ...rows.map((reg) => ({ kind: "session" as const, reg })),
  ].sort((a, b) => {
    const da = a.kind === "session" ? a.reg.session_date : a.pay.paid_at;
    const db = b.kind === "session" ? b.reg.session_date : b.pay.paid_at;
    const c = db.localeCompare(da);
    if (c !== 0) return c;
    if (a.kind === "session" && b.kind === "session") {
      return String(b.reg.start_time).localeCompare(String(a.reg.start_time));
    }
    return 0;
  });
  return [{ title, data }];
}

function defaultEndISO() {
  return toISODateLocal(new Date());
}

type Athlete = { user_id: string; full_name: string; username: string; phone: string };
type QuickLinked = { id: string; full_name: string; phone: string; linked_user_id: string | null };
type PickerRow =
  | ({ kind: "athlete" } & Athlete)
  | ({ kind: "quick" } & QuickLinked);

export default function ParticipantHistoryScreen({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const { presetUserId } = useLocalSearchParams<{ presetUserId?: string }>();
  const { language, t, isRTL } = useI18n();
  const pathname = usePathname();
  const isCoachHistory = pathname?.startsWith("/coach/participant-history") ?? false;
  const [start, setStart] = useState(() => firstDayOfMonthISOLocal());
  const [end, setEnd] = useState(defaultEndISO);
  const [athleteId, setAthleteId] = useState<string>("");
  const [athleteLabel, setAthleteLabel] = useState<string>("");
  const [phone, setPhone] = useState(""); // used as RPC filter; set from athlete selection
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [athletes, setAthletes] = useState<PickerRow[]>([]);
  const [athletesLoading, setAthletesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [rows, setRows] = useState<ParticipantHistoryRow[]>([]);
  const [accountPayments, setAccountPayments] = useState<AthleteAccountPayment[]>([]);
  const [pricingByCap, setPricingByCap] = useState<Record<number, number>>({});
  const [payeeIsManual, setPayeeIsManual] = useState(false);
  const [addPayOpen, setAddPayOpen] = useState(false);
  const [addPayAmount, setAddPayAmount] = useState("");
  const [addPayMethod, setAddPayMethod] = useState<"cash" | "paybox" | "other">("cash");
  const [addPayNote, setAddPayNote] = useState("");
  const [addPayDate, setAddPayDate] = useState(defaultEndISO);
  const [addPayBusy, setAddPayBusy] = useState(false);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  /** True after a successful Load for the current athlete/date range (hides billing card on fetch error). */
  const [reportReady, setReportReady] = useState(false);
  const [emptyHint, setEmptyHint] = useState<string>(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");

  function showError(msg: string) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(msg);
    } else {
      Alert.alert(t("common.error"), msg);
    }
  }

  function confirmDeleteAccountPayment(paymentId: string) {
    const msg = t("billing.deletePaymentConfirm");
    const runDelete = () => {
      void (async () => {
        setDeletingPaymentId(paymentId);
        const { error } = await supabase.from("athlete_account_payments").delete().eq("id", paymentId);
        setDeletingPaymentId(null);
        if (error) {
          showError(error.message);
          return;
        }
        if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("billing.paymentDeleted"));
        else Alert.alert("", t("billing.paymentDeleted"));
        await load();
      })();
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(msg)) runDelete();
      return;
    }
    Alert.alert(language === "he" ? "אישור" : "Confirm", msg, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("billing.deletePayment"), style: "destructive", onPress: runDelete },
    ]);
  }

  const sections = useMemo(() => {
    if (!hasSearched) return [];
    return mergedHistorySections(rows, accountPayments, athleteLabel);
  }, [hasSearched, rows, accountPayments, athleteLabel]);

  const billingSummary = useMemo(() => {
    if (!hasSearched || !athleteId) return null;
    return computeBillingSummary(rows, accountPayments, pricingByCap);
  }, [hasSearched, athleteId, rows, accountPayments, pricingByCap]);

  useEffect(() => {
    const uid = typeof presetUserId === "string" ? presetUserId : Array.isArray(presetUserId) ? presetUserId[0] : undefined;
    if (!uid) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, username, phone")
        .eq("user_id", uid)
        .maybeSingle();
      if (error || !data) return;
      setAthleteId(uid);
      setPayeeIsManual(false);
      setAthleteLabel(`${data.full_name} (@${data.username ?? ""}) · ${data.phone ?? ""}`);
      setPhone((data.phone ?? "").trim());
    })();
  }, [presetUserId]);

  const loadAthletes = useCallback(async () => {
    const q = pickerQ.trim();
    setAthletesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;

    let mQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      mQuery = mQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data: mData, error: mErr } = await mQuery;

    setAthletesLoading(false);
    if (error) {
      setAthletes([]);
      return;
    }
    const base = ((data as Athlete[]) ?? []).map((a) => ({ kind: "athlete" as const, ...a }));
    const quick = mErr ? [] : (((mData as QuickLinked[]) ?? []).map((m) => ({ kind: "quick" as const, ...m })));

    const seen = new Set<string>(base.map((b) => b.user_id));
    // Dedup linked quick entries that already appear in the athlete list.
    // Unlinked quick adds (linked_user_id = null) should always show.
    const quickDedup = quick.filter((m) => (m.linked_user_id ? !seen.has(m.linked_user_id) : true));
    setAthletes([...quickDedup, ...base]);
  }, [pickerQ]);

  const load = useCallback(async () => {
    const s = start.trim();
    const e = end.trim();
    if (!isValidISODateString(s) || !isValidISODateString(e)) {
      showError(language === "he" ? "בחרו תאריכי התחלה וסיום תקינים." : "Please choose valid start and end dates.");
      return;
    }
    if (s > e) {
      showError(language === "he" ? "תאריך ההתחלה חייב להיות לפני או שווה לתאריך הסיום." : "Start date must be on or before end date.");
      return;
    }
    if (!athleteId) {
      showError(language === "he" ? "בחרו מתאמן קודם." : "Choose an athlete first.");
      return;
    }
    setLoading(true);
    setReportReady(false);
    const phoneArg = phone.trim().length > 0 ? phone.trim() : null;
    const [histRes, priceRes, acctRes] = await Promise.all([
      supabase.rpc("participant_registration_history", {
        p_start: s,
        p_end: e,
        p_phone_search: phoneArg,
        p_athlete_key: athleteId,
      }),
      supabase.from("session_capacity_pricing").select("max_participants, price_ils"),
      supabase
        .from("athlete_account_payments")
        .select("id, payee_id, payee_is_manual, amount_ils, payment_method, note, paid_at, created_at, created_by")
        .gte("paid_at", s)
        .lte("paid_at", e)
        .eq("payee_id", athleteId)
        .eq("payee_is_manual", payeeIsManual)
        .order("paid_at", { ascending: false }),
    ]);

    if (histRes.error) {
      setLoading(false);
      showError(histRes.error.message);
      setRows([]);
      setAccountPayments([]);
      setReportReady(false);
      setHasSearched(true);
      return;
    }
    if (priceRes.error) {
      setLoading(false);
      showError(priceRes.error.message);
      setRows([]);
      setAccountPayments([]);
      setReportReady(false);
      setHasSearched(true);
      return;
    }
    if (acctRes.error) {
      setLoading(false);
      showError(acctRes.error.message);
      setRows([]);
      setAccountPayments([]);
      setReportReady(false);
      setHasSearched(true);
      return;
    }

    const next = (histRes.data as ParticipantHistoryRow[]) ?? [];
    setRows(next);
    setAccountPayments((acctRes.data as AthleteAccountPayment[]) ?? []);
    const capMap: Record<number, number> = {};
    for (const r of (priceRes.data as { max_participants: number; price_ils: number | string }[]) ?? []) {
      capMap[Number(r.max_participants)] = Number(r.price_ils);
    }
    setPricingByCap(capMap);

    if (next.length === 0 && ((acctRes.data as unknown[]) ?? []).length === 0) {
      setEmptyHint(language === "he" ? "אין רשומות לתאריכים שנבחרו." : "No records for those dates.");
    }

    setLoading(false);
    setReportReady(true);
    setHasSearched(true);
  }, [start, end, phone, athleteId, payeeIsManual, language]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        {!hideTitle ? (
          <Text style={[styles.screenTitle, isRTL && styles.rtlText]}>
            {t(isCoachHistory ? "menu.coachHistory" : "menu.athleteActivity")}
          </Text>
        ) : null}
        <DatePickerField label={t("common.from")} value={start} onChange={setStart} maximumDate={parseISODateLocal(end) ?? undefined} />
        <DatePickerField label={t("common.to")} value={end} onChange={setEnd} minimumDate={parseISODateLocal(start) ?? undefined} />
        <Text style={[styles.label, isRTL && styles.rtlText]}>
          {language === "he" ? "מתאמן (חיפוש לפי שם, משתמש או טלפון)" : "Athlete (search by name, username, or phone)"}
        </Text>
        <Pressable style={styles.pickerTouch} onPress={() => { setPickerOpen(true); loadAthletes(); }}>
          <Text style={athleteLabel ? styles.pickerText : styles.pickerPlaceholder}>
            {athleteLabel || (language === "he" ? "בחרו מתאמן…" : "Choose an athlete…")}
          </Text>
        </Pressable>
        {athleteId ? (
          <Pressable
            style={({ pressed }) => [styles.clearSel, pressed && { opacity: 0.9 }]}
            onPress={() => {
              setAthleteId("");
              setAthleteLabel("");
              setPhone("");
              setPayeeIsManual(false);
              setRows([]);
              setAccountPayments([]);
              setReportReady(false);
              setHasSearched(false);
            }}
          >
            <Text style={styles.clearSelTxt}>{t("common.clearSelection")}</Text>
          </Pressable>
        ) : null}
        <PrimaryButton label={t("common.load")} onPress={load} loading={loading} loadingLabel={t("common.loading")} />
      </View>

      {billingSummary && athleteId && reportReady ? (
        <View style={styles.billingCard}>
          <Text style={[styles.billingTitle, isRTL && styles.rtlText]}>{t("billing.summaryTitle")}</Text>
          <View style={styles.billingRow}>
            <Text style={[styles.billingLabel, isRTL && styles.rtlText]}>{t("billing.received")}</Text>
            <Text style={[styles.billingValue, isRTL && styles.rtlText]}>{`${Math.round(billingSummary.received * 100) / 100} ₪`}</Text>
          </View>
          <View style={styles.billingRow}>
            <Text style={[styles.billingLabel, isRTL && styles.rtlText]}>{t("billing.expected")}</Text>
            <Text style={[styles.billingValue, isRTL && styles.rtlText]}>{`${Math.round(billingSummary.expected * 100) / 100} ₪`}</Text>
          </View>
          <View style={styles.billingRow}>
            <Text style={[styles.billingLabel, isRTL && styles.rtlText]}>{t("billing.balance")}</Text>
            <Text
              style={[
                styles.billingValue,
                isRTL && styles.rtlText,
                billingSummary.balance > 0 ? styles.billingOwed : billingSummary.balance < 0 ? styles.billingCredit : null,
              ]}
            >
              {billingSummary.balance > 0
                ? t("billing.balanceOwes").replace("{n}", String(Math.round(Math.abs(billingSummary.balance) * 100) / 100))
                : billingSummary.balance < 0
                  ? t("billing.balanceCredit").replace("{n}", String(Math.round(Math.abs(billingSummary.balance) * 100) / 100))
                  : t("billing.balanceEven")}
            </Text>
          </View>
          {billingSummary.byMethod.length > 0 ? (
            <Text style={[styles.billingMethods, isRTL && styles.rtlText]}>
              {t("billing.byMethod")}
              {": "}
              {billingSummary.byMethod
                .map((x) => `${paymentMethodHistoryLabel(x.key, language)} · ${Math.round(x.total * 100) / 100} ₪`)
                .join(" · ")}
            </Text>
          ) : null}
          {billingSummary.missingRuleCount > 0 ? (
            <Text style={[styles.billingWarn, isRTL && styles.rtlText]}>
              {t("billing.missingRules").replace("{n}", String(billingSummary.missingRuleCount))}
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.addPayBtn, pressed && { opacity: 0.9 }]}
            onPress={() => {
              setAddPayAmount("");
              setAddPayNote("");
              setAddPayMethod("cash");
              setAddPayDate(toISODateLocal(new Date()));
              setAddPayOpen(true);
            }}
          >
            <Text style={styles.addPayBtnTxt}>{t("billing.addPayment")}</Text>
          </Pressable>
        </View>
      ) : null}

      <AppModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        variant="sheet"
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        cardStyle={styles.modalBox}
      >
        <View style={styles.modalHeader}>
          <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{language === "he" ? "מתאמנים" : "Athletes"}</Text>
          <Pressable onPress={() => setPickerOpen(false)}>
            <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
          </Pressable>
        </View>
        <View style={styles.modalSearchRow}>
          <TextInput
            value={pickerQ}
            onChangeText={setPickerQ}
            placeholder={language === "he" ? "חיפוש שם / משתמש / טלפון…" : "Search name / username / phone…"}
            placeholderTextColor={theme.colors.placeholderOnLight}
            style={styles.modalSearch}
            autoCapitalize="none"
            onSubmitEditing={loadAthletes}
          />
          <Pressable style={({ pressed }) => [styles.modalSearchBtn, pressed && { opacity: 0.9 }]} onPress={loadAthletes}>
            <Text style={styles.modalSearchBtnTxt}>{t("common.search")}</Text>
          </Pressable>
        </View>
        {athletesLoading ? (
          <ActivityIndicator size="large" color={theme.colors.textOnLight} style={styles.modalLoader} />
        ) : (
          <FlatList
            data={athletes}
            keyExtractor={(item) => (item.kind === "athlete" ? item.user_id : `quick:${item.id}`)}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                onPress={() => {
                  if (item.kind === "athlete") {
                    setAthleteId(item.user_id);
                    setPayeeIsManual(false);
                    setAthleteLabel(`${item.full_name} (@${item.username}) · ${item.phone}`);
                    setPhone(item.phone);
                  } else {
                    setAthleteId(item.linked_user_id ?? item.id);
                    setPayeeIsManual(!item.linked_user_id);
                    setAthleteLabel(
                      `${item.full_name} · ${item.phone} · ${
                        item.linked_user_id
                          ? language === "he"
                            ? "קישור מרשימת מהיר"
                            : "Quick Add link"
                          : language === "he"
                            ? "ללא חשבון"
                            : "No account"
                      }`
                    );
                    setPhone(item.phone);
                  }
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.pickerItemName}>{item.full_name}</Text>
                <Text style={styles.pickerItemRole}>
                  {item.kind === "athlete" ? `@${item.username} · ${item.phone}` : `${item.phone} · ${language === "he" ? "מהיר" : "Quick Add"}`}
                </Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[styles.pickerEmpty, isRTL && styles.rtlText]}>{language === "he" ? "אין מתאמנים" : "No athletes"}</Text>
            }
          />
        )}
      </AppModal>

      <AppModal
        visible={addPayOpen}
        onClose={() => setAddPayOpen(false)}
        variant="sheet"
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        cardStyle={styles.modalBox}
      >
        <View style={styles.modalHeader}>
          <Text style={[styles.modalTitle, isRTL && styles.rtlText]}>{t("billing.addPaymentTitle")}</Text>
          <Pressable onPress={() => setAddPayOpen(false)}>
            <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
          </Pressable>
        </View>
        <View style={styles.addPayBody}>
          <DatePickerField label={t("billing.paidOn")} value={addPayDate} onChange={setAddPayDate} />
          <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.amount")}</Text>
          <TextInput
            value={addPayAmount}
            onChangeText={setAddPayAmount}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={theme.colors.placeholderOnLight}
            style={styles.inputLight}
          />
          <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.method")}</Text>
          <View style={styles.methodRow}>
            {(["cash", "paybox", "other"] as const).map((m) => {
              const on = addPayMethod === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setAddPayMethod(m)}
                  style={({ pressed }) => [
                    styles.methodChip,
                    on && styles.methodChipOn,
                    pressed && !on && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[styles.methodChipTxt, on && styles.methodChipTxtOn]}>
                    {paymentMethodHistoryLabel(m, language)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.label, isRTL && styles.rtlText]}>{t("billing.noteOptional")}</Text>
          <TextInput
            value={addPayNote}
            onChangeText={setAddPayNote}
            placeholder="…"
            placeholderTextColor={theme.colors.placeholderOnLight}
            style={styles.inputLight}
          />
          <PrimaryButton
            label={t("common.save")}
            loading={addPayBusy}
            loadingLabel={t("common.loading")}
            onPress={() => {
              void (async () => {
                const amt = Number.parseFloat(addPayAmount.replace(",", ".").trim());
                if (!Number.isFinite(amt) || amt <= 0) {
                  showError(language === "he" ? "הזינו סכום תקין." : "Enter a valid amount.");
                  return;
                }
                setAddPayBusy(true);
                const { error } = await supabase.from("athlete_account_payments").insert({
                  payee_id: athleteId,
                  payee_is_manual: payeeIsManual,
                  amount_ils: amt,
                  payment_method: addPayMethod,
                  note: addPayNote.trim() || null,
                  paid_at: addPayDate.trim(),
                });
                setAddPayBusy(false);
                if (error) {
                  showError(error.message);
                  return;
                }
                setAddPayOpen(false);
                if (Platform.OS === "web" && typeof window !== "undefined") window.alert(t("billing.paymentSaved"));
                else Alert.alert("", t("billing.paymentSaved"));
                await load();
              })();
            }}
          />
        </View>
      </AppModal>

      <SectionList
        style={styles.list}
        sections={sections}
        keyExtractor={(item) => (item.kind === "session" ? item.reg.registration_id : `pay:${item.pay.id}`)}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === "payment") {
            const p = item.pay;
            const amt = parseMoney(p.amount_ils);
            const amtTxt = amt !== null && amt > 0 ? `${amt} ₪` : "—";
            const busyPay = deletingPaymentId === p.id;
            return (
              <View style={[styles.row, styles.paymentRow]}>
                <View style={[styles.paymentRowHead, isRTL && styles.paymentRowHeadRtl]}>
                  <Text style={[styles.rowDate, isRTL && styles.rtlText, styles.paymentRowDate]} numberOfLines={1}>
                    {formatISODateFull(p.paid_at, language)}
                  </Text>
                  <Pressable
                    onPress={() => confirmDeleteAccountPayment(p.id)}
                    disabled={busyPay}
                    style={({ pressed }) => [styles.paymentDeleteBtn, pressed && !busyPay && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t("billing.deletePayment")}
                  >
                    {busyPay ? (
                      <ActivityIndicator size="small" color={theme.colors.error} />
                    ) : (
                      <Text style={styles.paymentDeleteTxt}>{t("billing.deletePayment")}</Text>
                    )}
                  </Pressable>
                </View>
                <View style={[styles.badge, styles.badgePayment]}>
                  <Text style={[styles.badgeTxt, styles.badgeTxtPayment]}>{t("billing.accountPayment")}</Text>
                </View>
                <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>
                  {paymentMethodHistoryLabel(p.payment_method, language)} · {amtTxt}
                </Text>
                {(p.note ?? "").trim().length > 0 ? (
                  <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>{p.note}</Text>
                ) : null}
              </View>
            );
          }
          const reg = item.reg;
          const att = reg.attended;
          const attLabel =
            att === true
              ? language === "he"
                ? "הגיע"
                : "Arrived"
              : att === false
                ? language === "he"
                  ? "נעדר"
                  : "Absent"
                : language === "he"
                  ? "נוכחות לא סומנה"
                  : "Attendance not set";
          const attStyle =
            att === true ? styles.badgeAttYes : att === false ? styles.badgeAttNo : styles.badgeAttUnset;
          const attTxtStyle =
            att === true ? styles.badgeAttTxtYes : att === false ? styles.badgeAttTxtNo : styles.badgeAttTxtUnset;
          const hasPaymentMethod = normalizePaymentMethodKey(reg.payment_method) !== "(none)";
          const amtRaw = reg.amount_paid;
          const amt =
            amtRaw !== null && amtRaw !== undefined && String(amtRaw).trim() !== ""
              ? Number(amtRaw)
              : null;
          const amtOk = amt !== null && Number.isFinite(amt);
          const reason = (reg.cancellation_reason ?? "").trim();
          const raw12 = reg.cancellation_within_12h;
          const within12 =
            raw12 === true || (raw12 == null && reg.cancellation_within_24h === true);
          const within12ExplicitFalse =
            raw12 === false || (raw12 == null && reg.cancellation_within_24h === false);
          const late =
            within12
              ? language === "he"
                ? "ביטול בתוך 12 ש׳ לפני האימון"
                : "Cancelled within 12h of session start"
              : within12ExplicitFalse
                ? language === "he"
                  ? "ביטול מעל 12 ש׳ מראש"
                  : "Cancelled more than 12h before session"
                : null;
          return (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={[styles.rowDate, isRTL && styles.rtlText]} numberOfLines={1} ellipsizeMode="tail">
                  {formatISODateFull(reg.session_date, language)}
                </Text>
                <Text style={[styles.rowTime, isRTL && styles.rtlText]} numberOfLines={1} ellipsizeMode="tail">
                  {formatSessionTimeRange(reg.start_time, reg.duration_minutes ?? 60)}
                </Text>
                <View style={[styles.badge, reg.reg_status === "active" ? styles.badgeOn : styles.badgeOff]}>
                  <Text style={[styles.badgeTxt, reg.reg_status === "active" ? styles.badgeTxtOn : styles.badgeTxtOff]}>
                    {reg.reg_status === "active"
                      ? language === "he"
                        ? "פעיל"
                        : "Active"
                      : language === "he"
                        ? "בוטל"
                        : "Cancelled"}
                  </Text>
                </View>
                {reg.reg_status === "active" ? (
                  <View style={[styles.badge, attStyle, styles.badgeAtt]}>
                    <Text style={[styles.badgeTxt, attTxtStyle]}>{attLabel}</Text>
                  </View>
                ) : null}
              </View>
              {typeof reg.max_participants === "number" && reg.max_participants > 0 ? (
                <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>
                  {language === "he" ? "גודל קבוצה (מקס׳ משתתפים): " : "Group size (max spots): "}
                  {reg.max_participants}
                  {pricingByCap[reg.max_participants] != null
                    ? language === "he"
                      ? ` · מחיר: ${pricingByCap[reg.max_participants]} ₪`
                      : ` · Price: ${pricingByCap[reg.max_participants]} ₪`
                    : ""}
                </Text>
              ) : null}
              {hasPaymentMethod ? (
                <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>
                  {language === "he" ? "תשלום: " : "Payment: "}
                  {paymentMethodHistoryLabel(reg.payment_method, language)}
                  {amtOk ? (language === "he" ? ` · ${amt} ₪` : ` · ${amt}`) : ""}
                </Text>
              ) : amtOk ? (
                <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>
                  {language === "he" ? "סכום: " : "Amount: "}
                  {language === "he" ? `${amt} ₪` : `${amt}`}
                </Text>
              ) : null}
              {reg.reg_status === "cancelled" ? (
                <>
                  {reason.length > 0 ? (
                    <Text style={[styles.rowDetail, isRTL && styles.rtlText]}>
                      {language === "he" ? "סיבת ביטול: " : "Cancellation reason: "}
                      {reason}
                    </Text>
                  ) : null}
                  {late ? (
                    <View style={[styles.badge, within12 ? styles.badgeLate : styles.badgeLateOk]}>
                      <Text style={[styles.badgeTxt, within12 ? styles.badgeLateTxt : styles.badgeLateOkTxt]}>{late}</Text>
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!hasSearched
              ? language === "he"
                ? "בחרו טווח תאריכים ומתאמן, ואז לחצו על טען."
                : "Set the period (and optional phone), then tap Load."
              : emptyHint}
          </Text>
        }
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  rtlText: { textAlign: "right" },
  filters: {
    margin: theme.spacing.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
  },
  screenTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.sm },
  label: { marginTop: theme.spacing.sm, fontWeight: "600", color: theme.colors.text, fontSize: 13 },
  hint: { marginTop: theme.spacing.sm, fontSize: 12, color: theme.colors.textMuted, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  pickerTouch: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    backgroundColor: theme.colors.white,
    minHeight: 48,
    justifyContent: "center",
  },
  pickerText: { fontSize: 16, color: theme.colors.textOnLight },
  pickerPlaceholder: { fontSize: 16, color: theme.colors.textSoftOnLight },
  clearSel: { marginTop: 8, alignSelf: "flex-start" },
  clearSelTxt: { color: theme.colors.textMuted, fontWeight: "700" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end" },
  modalBackdropTouch: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  modalBox: { backgroundColor: theme.colors.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.textOnLight },
  modalClose: { fontSize: 16, color: theme.colors.textMutedOnLight, fontWeight: "700" },
  modalSearchRow: { flexDirection: "row", gap: 10, padding: theme.spacing.md, paddingTop: theme.spacing.sm },
  modalSearch: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  modalSearchBtn: { paddingHorizontal: 14, borderRadius: theme.radius.md, backgroundColor: theme.colors.cta, alignItems: "center", justifyContent: "center" },
  modalSearchBtnTxt: { color: theme.colors.ctaText, fontWeight: "800" },
  modalLoader: { padding: theme.spacing.xl },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.border },
  pickerItemName: { fontSize: 16, fontWeight: "600", color: theme.colors.textOnLight },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMutedOnLight, marginTop: 4 },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoftOnLight, textAlign: "center" },
  list: { flex: 1 },
  listContent: { paddingBottom: theme.spacing.xl, flexGrow: 1 },
  sectionHead: {
    backgroundColor: theme.colors.surfaceElevated,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.lg,
    marginHorizontal: theme.spacing.md,
  },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  row: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    padding: theme.spacing.md,
    flexDirection: "column",
    alignItems: "stretch",
    overflow: "hidden",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  rowMain: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
  },
  rowMainRtl: { flexDirection: "row-reverse" },
  rowDetail: { marginTop: 8, fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  rowDate: { fontSize: 15, fontWeight: "700", color: theme.colors.text, flex: 1, minWidth: 120, flexShrink: 1 },
  rowTime: { fontSize: 14, color: theme.colors.cta, fontWeight: "600", flex: 1, minWidth: 90, flexShrink: 1 },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    flexShrink: 0,
  },
  badgeOn: { backgroundColor: theme.colors.successBg },
  badgeOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeTxt: { fontSize: 11, fontWeight: "800" },
  badgeTxtOn: { color: theme.colors.success },
  badgeTxtOff: { color: theme.colors.textMuted },
  badgeAtt: {},
  badgeAttYes: { backgroundColor: theme.colors.successBg, borderWidth: 0 },
  badgeAttTxtYes: { color: theme.colors.success },
  badgeAttNo: { backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  badgeAttTxtNo: { color: theme.colors.error },
  badgeAttUnset: { backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeAttTxtUnset: { color: theme.colors.textMuted },
  badgeLate: { marginTop: 6, backgroundColor: theme.colors.errorBg, borderWidth: 1, borderColor: theme.colors.errorBorder },
  badgeLateTxt: { color: theme.colors.error },
  badgeLateOk: { marginTop: 6, backgroundColor: theme.colors.surfaceElevated, borderWidth: 1, borderColor: theme.colors.borderMuted },
  badgeLateOkTxt: { color: theme.colors.textMuted },
  empty: { textAlign: "center", color: theme.colors.textSoft, padding: theme.spacing.xl, fontSize: 14 },
  billingCard: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  billingTitle: { fontSize: 13, fontWeight: "900", color: theme.colors.textMuted, letterSpacing: 0.3, textTransform: "uppercase" },
  billingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  billingLabel: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  billingValue: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  billingOwed: { color: theme.colors.error },
  billingCredit: { color: theme.colors.success },
  billingMethods: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 18, marginTop: 4 },
  billingWarn: { fontSize: 12, color: theme.colors.textSoft, marginTop: 4, lineHeight: 17 },
  addPayBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  addPayBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 13 },
  addPayBody: { padding: theme.spacing.md, gap: 8, paddingBottom: theme.spacing.lg },
  inputLight: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  methodRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  methodChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
  },
  methodChipOn: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  methodChipTxt: { fontSize: 12, fontWeight: "800", color: theme.colors.text },
  methodChipTxtOn: { color: theme.colors.ctaText },
  paymentRow: { borderLeftWidth: 3, borderLeftColor: theme.colors.cta },
  badgePayment: { backgroundColor: "rgba(96, 165, 250, 0.15)", borderWidth: 1, borderColor: theme.colors.cta },
  badgeTxtPayment: { color: theme.colors.cta },
  paymentRowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
  },
  paymentRowHeadRtl: { flexDirection: "row-reverse" },
  paymentRowDate: { flex: 1, minWidth: 0 },
  paymentDeleteBtn: { paddingVertical: 6, paddingHorizontal: 8 },
  paymentDeleteTxt: { fontSize: 13, fontWeight: "800", color: theme.colors.error },
});
