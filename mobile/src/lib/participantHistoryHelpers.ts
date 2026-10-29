import { normalizePaymentMethodKey } from "./paymentMethod";
import { resolveSessionBillingPriceLocal } from "./sessionSlotPrice";
import type { AthleteFamily } from "./athleteFamilies";
import type { PricingRateTierRow } from "./pricingRates";
import type { AthleteAccountPayment, ParticipantHistoryRow } from "../types/database";

export type HistorySection = { title: string; data: HistoryListItem[] };
export type HistoryListItem =
  | { kind: "session"; reg: ParticipantHistoryRow }
  | { kind: "payment"; pay: AthleteAccountPayment };

export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Key into a roster-slot-price-override map: one override per (session, payee). */
export function rosterOverrideKey(sessionId: string, isManual: boolean, payeeId: string): string {
  return `${sessionId}:${isManual ? "m" : "u"}:${payeeId}`;
}

export type AttStatus = "unset" | "arrived" | "absent";

export function attStatusFromRow(reg: ParticipantHistoryRow): AttStatus {
  return reg.attended === true ? "arrived" : reg.attended === false ? "absent" : "unset";
}

export function attStatusLabel(status: AttStatus, t: (key: string) => string): string {
  if (status === "arrived") return t("participantHistory.attendanceArrived");
  if (status === "absent") return t("participantHistory.attendanceAbsent");
  return t("participantHistory.attendanceNotSet");
}

export type BillingSummary = {
  received: number;
  expected: number;
  missingRuleCount: number;
  byMethod: { key: string; total: number }[];
  balance: number;
  /** Net subscription charges (recurring/proration minus reversals) accrued in this period; included in `expected`. */
  subscriptionChargesIls: number;
};

export function computeBillingSummary(
  regs: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  globalTiers: PricingRateTierRow[],
  athleteTiers: PricingRateTierRow[],
  globalKickboxTiers: PricingRateTierRow[],
  sessionCustomById: Record<string, number | null>,
  sessionKickboxById: Record<string, boolean>,
  rosterPriceByKey: Record<string, number>,
  isManualRow: (reg: ParticipantHistoryRow) => boolean,
  athleteTiersByMember?: Record<string, PricingRateTierRow[]>,
  memberKeyForRow?: (reg: ParticipantHistoryRow) => string | null,
  /** registration_id (app rows) or manual_participant_id (manual rows) of sessions covered by an active subscription — owe nothing of their own. */
  coveredRegistrationIds?: Set<string>,
  /** Net subscription charges (recurring/proration minus reversals) posted for this payee whose billing period starts in this report's date range. */
  subscriptionChargesIls?: number
): BillingSummary {
  const methodTotals = new Map<string, number>();

  function addToMethod(rawMethod: string | null | undefined, amount: number) {
    if (amount <= 0) return;
    let k = normalizePaymentMethodKey(rawMethod);
    if (k === "(none)") k = "other";
    methodTotals.set(k, (methodTotals.get(k) ?? 0) + amount);
  }

  let received = 0;
  // "Discount" account payments aren't real money received — they reduce what was
  // expected instead (see below), so they're tracked separately here rather than added
  // to `received`. Still counted in `byMethod` so the breakdown shows how much discount
  // was given, same as any other method.
  let discountTotal = 0;
  for (const r of regs) {
    const amt = parseMoney(r.amount_paid);
    if (amt !== null && amt > 0) {
      received += amt;
      addToMethod(r.payment_method, amt);
    }
  }
  for (const p of payments) {
    // A reversed payment (refund / cancelled receipt) is kept for audit but is no longer
    // real money collected — excluding it here matches the backend's authoritative
    // reconciliation (_period_merged_athlete_finance / manager_weekly_stats_core).
    if (p.reversed_at) continue;
    const amt = parseMoney(p.amount_ils);
    if (amt !== null && amt > 0) {
      if (normalizePaymentMethodKey(p.payment_method) === "discount") {
        discountTotal += amt;
      } else {
        received += amt;
      }
      addToMethod(p.payment_method, amt);
    }
  }

  let expected = 0;
  let missingRuleCount = 0;
  for (const r of regs) {
    // A session covered by an active subscription owes nothing of its own — the
    // subscription charge itself (added below) is its sole debt line, so this is never
    // double-counted with the charge.
    if (coveredRegistrationIds?.has(r.registration_id)) continue;
    const cap = typeof r.max_participants === "number" ? r.max_participants : null;
    const lateCancelOwes =
      r.reg_status === "cancelled" &&
      r.cancellation_within_12h === true &&
      r.cancellation_charged === true;
    const owes =
      (r.reg_status === "active" && r.attended === true) ||
      (r.reg_status === "active" && r.attended === false && r.charge_no_show === true) ||
      lateCancelOwes;
    if (!owes || cap === null || cap <= 0) continue;
    const sessionDate = r.session_date;
    const memberKey = memberKeyForRow?.(r) ?? null;
    const rowAthleteTiers =
      memberKey && athleteTiersByMember?.[memberKey] ? athleteTiersByMember[memberKey]! : athleteTiers;
    const overrideKey = rosterOverrideKey(r.session_id, isManualRow(r), r.athlete_user_id);
    const price =
      rosterPriceByKey[overrideKey] ??
      resolveSessionBillingPriceLocal({
        customSlotPriceIls: sessionCustomById[r.session_id],
        maxParticipants: cap,
        isKickbox: sessionKickboxById[r.session_id] ?? false,
        sessionDate,
        athleteTiers: rowAthleteTiers,
        globalTiers,
        globalKickboxTiers,
      });
    if (price === null) missingRuleCount += 1;
    else expected += price;
  }
  // Subscription charges (recurring/proration, net of reversals) are an additional
  // debt-feed line item, attributed to the billing period they were posted for — not
  // smeared across individual sessions. Added after per-session `expected` but before
  // the discount clamp, matching the backend's merged reconciliation.
  const netSubscriptionCharges = subscriptionChargesIls ?? 0;
  // Clamp rather than let expected go negative if a discount exceeds what was actually owed.
  expected = Math.max(0, expected + netSubscriptionCharges - discountTotal);

  for (const r of regs) {
    const pc = parseMoney(r.cancellation_penalty_collected);
    if (pc != null && pc > 0) {
      received += pc;
      addToMethod(r.cancellation_payment_method, pc);
    }
  }

  const byMethod = Array.from(methodTotals.entries())
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);

  return {
    received,
    expected,
    missingRuleCount,
    byMethod,
    balance: expected - received,
    subscriptionChargesIls: netSubscriptionCharges,
  };
}

export function mergedHistorySections(
  rows: ParticipantHistoryRow[],
  payments: AthleteAccountPayment[],
  athleteLabel: string,
  familyContext?: AthleteFamily | null
): HistorySection[] {
  const title = familyContext
    ? familyContext.name
    : rows.length > 0
      ? `${rows[0]!.athlete_name} · ${rows[0]!.athlete_phone}`
      : athleteLabel.trim() || "—";
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

export type Athlete = { user_id: string; full_name: string; username: string; phone: string };
export type QuickLinked = { id: string; full_name: string; phone: string; linked_user_id: string | null };
export type PickerRow =
  | ({ kind: "athlete" } & Athlete)
  | ({ kind: "quick" } & QuickLinked);
