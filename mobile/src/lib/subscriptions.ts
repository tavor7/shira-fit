/**
 * Phase 4B — thin client-side helpers for the Phase 4A subscription-management RPCs.
 *
 * This module is intentionally "dumb": it only shapes/validates INPUT for the RPC calls (basic
 * field-presence/format checks so the UI can show inline errors before round-tripping) and
 * formats RPC OUTPUT for display. It never computes impact, pricing, coverage, or duration
 * semantics itself — those are 100% owned by the backend (subscription_compute_impact,
 * subscription_billing_period_amount, has_no_end_date, etc.). Every mutating call here is a
 * pass-through to the real RPC.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Matches public.subscription_tier exactly (7 values, capacity-based). */
export const SUBSCRIPTION_TIERS = ["personal", "pair", "trio", "quartet", "quintet", "sextet", "group"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export type AllowanceInput = { tier: SubscriptionTier; weekly_limit: number };

export type WeeklyLimits = Partial<Record<SubscriptionTier, number>>;

export type SubscriptionListRow = {
  subscription_id: string;
  payee_id: string;
  payee_is_manual: boolean;
  payee_display_name: string;
  version_id: string;
  display_status: string;
  monthly_price_ils: number;
  anchor_day: number;
  plan_start_date: string;
  /** As configured -- prefer effective_plan_end_date for display (extended by any freeze). */
  plan_end_date: string | null;
  /** Configured plan_end_date extended by every applicable freeze day; null iff has_no_end_date. */
  effective_plan_end_date: string | null;
  has_no_end_date: boolean;
  /** Already reflects cumulative freeze shift -- never recompute this on the client. */
  next_billing_date: string | null;
  is_frozen: boolean;
  current_weekly_limits: WeeklyLimits;
};

export type SubscriptionHistoryRow = {
  subscription_id: string;
  payee_id: string;
  payee_is_manual: boolean;
  payee_display_name: string;
  version_id: string;
  display_status: string;
  monthly_price_ils: number;
  plan_start_date: string;
  plan_end_date: string | null;
  is_tombstoned: boolean;
};

export type SubscriptionVersionRow = {
  id: string;
  subscription_id: string;
  version_no: number;
  effective_from: string;
  effective_to: string | null;
  monthly_price_ils: number;
  anchor_day: number;
  plan_start_date: string;
  plan_end_date: string | null;
  /** Configured plan_end_date extended by every applicable freeze day; null iff has_no_end_date. */
  effective_plan_end_date: string | null;
  has_no_end_date: boolean;
  stopped_effective_date: string | null;
  superseded_by: string | null;
  created_at: string;
  display_status: string;
  allowances: WeeklyLimits;
};

export type SubscriptionFreezeRow = {
  id: string;
  subscription_id: string;
  freeze_from: string;
  freeze_until: string;
  created_at: string;
  cancelled_at: string | null;
  ended_early_at?: string | null;
  original_freeze_until?: string | null;
};

export type SubscriptionChargeRow = {
  id: string;
  amount_ils: number;
  charge_type: string;
  reverses: string | null;
  created_at: string;
};

/** Summarize a billing period's charges into the single amount currently in effect (the one
 * non-reversal charge no reversal points at yet), for human-readable display — never surfaces the
 * raw reversal/correction ledger rows in the UI. Mirrors the backend's own "currently effective
 * charge" resolution (subscription_generate_or_correct_billing_period), read-only here. */
export function currentEffectiveChargeAmount(charges: SubscriptionChargeRow[]): number | null {
  const reversedIds = new Set(charges.filter((c) => c.charge_type === "reversal" && c.reverses).map((c) => c.reverses as string));
  const candidates = charges.filter((c) => c.charge_type !== "reversal" && !reversedIds.has(c.id));
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return latest.amount_ils;
}

export type SubscriptionBillingPeriodRow = {
  period_id: string;
  period_start: string;
  period_end: string;
  charges: SubscriptionChargeRow[];
};

export type SubscriptionDetail = {
  ok: true;
  subscription: { id: string; payee_id: string; payee_is_manual: boolean; created_at: string; deleted_at: string | null };
  versions: SubscriptionVersionRow[];
  freezes: SubscriptionFreezeRow[];
  billing_periods: SubscriptionBillingPeriodRow[];
  /** Already reflects cumulative freeze shift -- never recompute this on the client. */
  next_billing_date: string | null;
};

/** Per-tier usage row for one studio week -- same shape as the athlete's AthleteWeeklyUsageRow
 * (both come from the shared _subscription_week_usage engine), reusable with tierUsageFromRow. */
export type SubscriptionWeeklyUsageRow = {
  tier: SubscriptionTier;
  configured_weekly_limit: number;
  effective_weekly_limit: number;
  used: number;
  extra: number;
};

export type SubscriptionWeeklyUsage = {
  ok: true;
  week_start: string;
  week_end: string;
  window_days: number;
  active_days: number;
  frozen_days: number;
  usage: SubscriptionWeeklyUsageRow[];
};

export type ImpactRegistrationItem = {
  registration_id: string | null;
  manual_participant_id: string | null;
  session_date: string;
  week_start: string;
  tier: SubscriptionTier;
  new_non_coverage_reason: string | null;
};

export type FutureRegistrationAction = "remove" | "charge_regular_price";

/** One currently-covered registration for a session on/after the subscription's termination date
 * (stop_subscription / delete_subscription's future-registrations preview). week_start is not part of
 * this payload -- unlike ImpactRegistrationItem, these are never-yet-reconciled rows. */
export type FutureRegistrationItem = {
  registration_id: string | null;
  manual_participant_id: string | null;
  session_date: string;
  tier: SubscriptionTier;
  /** What this session would cost if resolved as "charge_regular_price" -- informational only, never
   * charged by the preview itself. */
  regular_price_ils: number;
};

export type SubscriptionImpact = {
  ok: boolean;
  error?: string;
  count: number;
  items: ImpactRegistrationItem[];
  current_monthly_price_ils?: number;
  /** Freeze preview only -- computed by actually running the real correction logic inside a
   * rolled-back transaction; null/absent for stop/edit previews. */
  preview_next_billing_date?: string | null;
  preview_effective_plan_end_date?: string | null;
  estimate_note?: string;
};

export type RpcResult<T> = { ok: true } & T;
export type RpcError = {
  ok: false;
  error: string;
  subscription_id?: string;
  /** Present only on stop/delete-with-future-registrations' future_registrations_changed /
   * future_registrations_expectation_required errors -- the freshly recomputed list, so the UI can
   * refresh its own state from the SAME response instead of a second round trip. */
  future_registrations?: FutureRegistrationItem[];
  future_registrations_count?: number;
};
export type RpcOutcome<T> = RpcResult<T> | RpcError;

/** Convert an allowances record (from server jsonb) into the fixed 7-tier array the create/edit
 * RPCs expect, defaulting any missing tier to 0 — never invents a non-zero default. */
export function allowancesRecordToArray(record: WeeklyLimits): AllowanceInput[] {
  return SUBSCRIPTION_TIERS.map((tier) => ({ tier, weekly_limit: Math.max(0, Math.trunc(record[tier] ?? 0)) }));
}

/** Empty (all-zero) allowance draft, used when starting a new create form. */
export function emptyWeeklyLimits(): WeeklyLimits {
  const out: WeeklyLimits = {};
  for (const tier of SUBSCRIPTION_TIERS) out[tier] = 0;
  return out;
}

export type CreateSubscriptionInput = {
  payeeId: string;
  payeeIsManual: boolean;
  monthlyPriceIls: number;
  startDate: string; // YYYY-MM-DD
  endDate: string | null; // null => no end date
  allowances: WeeklyLimits;
  /** Optional initial payment recorded in the same transaction as the subscription. clientRequestId
   * is deliberately NOT part of this (it typically lives in a ref read only at submit time, and a
   * ref must never be read during render/memoization) -- pass it as the sibling
   * initialPaymentClientRequestId field instead. */
  initialPayment?: Omit<SubscriptionPaymentInput, "clientRequestId"> | null;
  initialPaymentClientRequestId?: string | null;
};

export type SubscriptionPaymentInput = {
  amountIls: number;
  paymentMethod: string;
  payerName?: string | null;
  note?: string | null;
  /** ISO date; omit/null to default to today (record_subscription_payment's own default). */
  paidAt?: string | null;
  /** Client-supplied idempotency token; a retry with the same value never duplicates the payment. */
  clientRequestId: string;
};

export type SubscriptionPaymentRow = {
  id: string;
  amount_ils: number;
  payment_method: string;
  payer_name: string | null;
  note: string | null;
  paid_at: string;
  reversed_at: string | null;
  created_at: string;
};

export type SubscriptionOverviewStats = {
  ok: true;
  active_subscriptions_count: number;
  charges_total_ils: number;
  payments_total_ils: number;
  outstanding_ils: number;
  running_count: number;
  frozen_count: number;
  scheduled_count: number;
  open_balance_ils: number;
  open_balance_count: number;
  credit_ils: number;
  charges_next_7d_count: number;
  charges_next_7d_ils: number;
  ending_next_14d_count: number;
  pending_corrections_count: number;
  awaiting_accounting_count: number;
};

export type SubscriptionWeekUtilizationRow = {
  payee_id: string;
  payee_is_manual: boolean;
  payee_display_name: string;
  subscription_id: string;
  tier: SubscriptionTier;
  available: number;
  occupied: number;
  attended: number;
  penalty: number;
  unmarked: number;
  reserved: number;
  released: number;
  extra: number;
  remaining: number;
  over: number;
};

/** manager_subscription_week_utilization. used + unmarked + reserved + remaining = available + over_allocated. */
export type SubscriptionWeekUtilization = {
  ok: true;
  week_start: string;
  week_end: string;
  mode: "closed" | "current" | "future";
  available: number;
  used: number;
  attended: number;
  penalty: number;
  unmarked: number;
  reserved: number;
  remaining: number;
  over_allocated: number;
  released: number;
  extra_regular_price: number;
  rows: SubscriptionWeekUtilizationRow[];
};

export type SubscriptionDeleteHistoryItem = {
  coverage_id: string;
  session_id: string;
  session_date: string;
  start_time: string;
  slot_state: "attended" | "penalty" | "unmarked";
  regular_price_ils: number;
  amount_paid_ils: number;
  has_receipt: boolean;
  receipts: { number: number | null; status: string; amount_ils: number | null }[];
  will_reprice: boolean;
  new_debt_ils: number;
};

export type SubscriptionDeleteImpact = {
  history_sessions: SubscriptionDeleteHistoryItem[];
  future_registrations: FutureRegistrationItem[];
  future_registrations_count: number;
  new_debt_ils: number;
  receipt_locked_count: number;
  repriced_count: number;
  correction_debt_if_applied_ils: number;
  charges_to_reverse_ils: number;
  blocking_payments_ils: number;
  blocking_payments_count: number;
  payee_discounts_ils: number;
  fingerprint: string;
};

export type SubscriptionCorrection = {
  id: string;
  subscription_id: string;
  session_id: string | null;
  session_date: string;
  payee_display_name: string;
  slot_state: "attended" | "penalty" | "unmarked";
  regular_price_ils: number;
  amount_paid_ils: number;
  balance_change_if_applied_ils: number;
  receipts: { number: number | null; status: string; amount_ils: number | null }[];
  status: "pending" | "awaiting_accounting" | "applied_regular_price" | "kept_covered";
  review_reason: string | null;
  review_requested_at: string | null;
};

export type UnfreezeKind = "future_cancel" | "current_end_early" | "past_reversal";

export type UnfreezeOutcome = {
  action: "preview" | "applied" | "already_applied";
  kind?: UnfreezeKind;
  freeze_from?: string;
  freeze_until?: string;
  session_changes?: { session_date: string; covered_before: boolean; covered_after: boolean; reason_after: string | null }[];
  sessions_kept_at_paid_regular_price?: number;
  next_billing_before?: string | null;
  next_billing_after?: string | null;
  plan_end_before?: string | null;
  plan_end_after?: string | null;
  charges_change_ils?: number;
  next_charge_becomes_due?: boolean;
};

export type SubscriptionOverviewBreakdownRow = {
  subscription_id: string;
  payee_id: string;
  payee_is_manual: boolean;
  payee_display_name: string;
  display_status: string;
  is_deleted: boolean;
  plan_start_date: string;
  plan_end_date: string | null;
  has_no_end_date: boolean;
  charges_total_ils: number;
  payments_total_ils: number;
  outstanding_ils: number;
  next_billing_date: string | null;
  effective_plan_end_date: string | null;
};

export type FieldValidationError = { field: string; messageKey: string };

/** Basic input-shape validation only (never re-implements the backend's business rules, e.g.
 * conflicting-lineage checks, which only the RPC can authoritatively decide). */
export function validateCreateSubscriptionInput(input: CreateSubscriptionInput): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  if (!input.payeeId) errors.push({ field: "payee", messageKey: "subscriptions.errPayeeRequired" });
  if (!Number.isFinite(input.monthlyPriceIls) || input.monthlyPriceIls < 0) {
    errors.push({ field: "price", messageKey: "subscriptions.errPriceInvalid" });
  }
  if (!isValidIsoDate(input.startDate)) errors.push({ field: "startDate", messageKey: "subscriptions.errStartDateInvalid" });
  if (input.endDate != null) {
    if (!isValidIsoDate(input.endDate)) errors.push({ field: "endDate", messageKey: "subscriptions.errEndDateInvalid" });
    else if (input.endDate < input.startDate) errors.push({ field: "endDate", messageKey: "subscriptions.errEndDateBeforeStart" });
  }
  for (const tier of SUBSCRIPTION_TIERS) {
    const v = input.allowances[tier] ?? 0;
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      errors.push({ field: `allowance_${tier}`, messageKey: "subscriptions.errAllowanceInvalid" });
    }
  }
  return errors;
}

/** A per-attempt idempotency token for record_subscription_payment / create_subscription's
 * initial-payment path -- does not need cryptographic randomness, just per-attempt uniqueness, so
 * no extra dependency is pulled in for this. Generate once per submit attempt (not once per
 * component mount) and reuse the SAME value across a retry of the SAME attempt. */
export function generateClientRequestId(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const rand = (n: number) => Array.from({ length: n }, hex).join("");
  return `${rand(8)}-${rand(4)}-4${rand(3)}-a${rand(3)}-${rand(12)}`;
}

export function isValidIsoDate(s: string | null | undefined): s is string {
  if (!s) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Human tier label + capacity hint, e.g. "Group training". Never expose the raw enum value. */
export function tierLabelKey(tier: SubscriptionTier): string {
  return `subscriptions.tier.${tier}`;
}

// ---------------------------------------------------------------------------
// RPC wrappers — thin pass-throughs, one function per Phase 4A RPC. No business logic here.
// ---------------------------------------------------------------------------

export async function rpcListActiveSubscriptions(supabase: SupabaseClient): Promise<SubscriptionListRow[]> {
  const { data, error } = await supabase.rpc("list_active_subscriptions");
  if (error) throw error;
  return (data ?? []) as SubscriptionListRow[];
}

export async function rpcListSubscriptionHistory(supabase: SupabaseClient): Promise<SubscriptionHistoryRow[]> {
  const { data, error } = await supabase.rpc("list_subscription_history");
  if (error) throw error;
  return (data ?? []) as SubscriptionHistoryRow[];
}

export async function rpcGetSubscriptionDetail(
  supabase: SupabaseClient,
  subscriptionId: string
): Promise<SubscriptionDetail | RpcError> {
  const { data, error } = await supabase.rpc("get_subscription_detail", { p_subscription_id: subscriptionId });
  if (error) throw error;
  return data as SubscriptionDetail | RpcError;
}

export async function rpcGetSubscriptionWeeklyUsage(
  supabase: SupabaseClient,
  subscriptionId: string,
  weekStart: string
): Promise<SubscriptionWeeklyUsage | RpcError> {
  const { data, error } = await supabase.rpc("get_subscription_weekly_usage", {
    p_subscription_id: subscriptionId,
    p_week_start: weekStart,
  });
  if (error) throw error;
  return data as SubscriptionWeeklyUsage | RpcError;
}

export async function rpcCreateSubscription(
  supabase: SupabaseClient,
  input: CreateSubscriptionInput
): Promise<RpcOutcome<{ subscription_id: string; version_id: string; payment_id: string | null }>> {
  const p = input.initialPayment;
  const { data, error } = await supabase.rpc("create_subscription", {
    p_payee_id: input.payeeId,
    p_payee_is_manual: input.payeeIsManual,
    p_monthly_price_ils: input.monthlyPriceIls,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_anchor_day: null,
    p_allowances: allowancesRecordToArray(input.allowances),
    p_initial_payment_amount_ils: p?.amountIls ?? null,
    p_initial_payment_method: p?.paymentMethod ?? null,
    p_initial_payment_payer_name: p?.payerName ?? null,
    p_initial_payment_note: p?.note ?? null,
    p_initial_payment_client_request_id: input.initialPaymentClientRequestId ?? null,
  });
  if (error) throw error;
  return data as RpcOutcome<{ subscription_id: string; version_id: string; payment_id: string | null }>;
}

export async function rpcRecordSubscriptionPayment(
  supabase: SupabaseClient,
  subscriptionId: string,
  payment: SubscriptionPaymentInput
): Promise<RpcOutcome<{ payment_id: string; duplicate: boolean }>> {
  const { data, error } = await supabase.rpc("record_subscription_payment", {
    p_subscription_id: subscriptionId,
    p_amount_ils: payment.amountIls,
    p_payment_method: payment.paymentMethod,
    p_payer_name: payment.payerName ?? null,
    p_note: payment.note ?? null,
    p_paid_at: payment.paidAt ?? null,
    p_client_request_id: payment.clientRequestId,
  });
  if (error) throw error;
  return data as RpcOutcome<{ payment_id: string; duplicate: boolean }>;
}

export async function fetchSubscriptionPayments(
  supabase: SupabaseClient,
  subscriptionId: string
): Promise<SubscriptionPaymentRow[]> {
  const { data, error } = await supabase
    .from("athlete_account_payments")
    .select("id, amount_ils, payment_method, payer_name, note, paid_at, reversed_at, created_at")
    .eq("source_subscription_id", subscriptionId)
    .order("paid_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SubscriptionPaymentRow[];
}

export async function rpcManagerSubscriptionOverviewStats(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string
): Promise<SubscriptionOverviewStats | RpcError> {
  const { data, error } = await supabase.rpc("manager_subscription_overview_stats", {
    p_start: startDate,
    p_end: endDate,
  });
  if (error) throw error;
  return data as SubscriptionOverviewStats | RpcError;
}

export async function rpcManagerSubscriptionOverviewBreakdown(
  supabase: SupabaseClient
): Promise<SubscriptionOverviewBreakdownRow[] | RpcError> {
  const { data, error } = await supabase.rpc("manager_subscription_overview_breakdown");
  if (error) throw error;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as RpcError;
  return (data ?? []) as SubscriptionOverviewBreakdownRow[];
}

export type EditSubscriptionInput = {
  subscriptionId: string;
  effectiveFrom: string;
  newPrice: number | null;
  newPlanEndDate: string | null;
  clearEndDate: boolean;
  newAllowances: WeeklyLimits | null;
  confirmed: boolean;
};

export async function rpcEditSubscriptionVersion(
  supabase: SupabaseClient,
  input: EditSubscriptionInput
): Promise<RpcOutcome<{ action: "preview" | "applied" | "already_applied"; impact?: SubscriptionImpact; version_id?: string }>> {
  const { data, error } = await supabase.rpc("edit_subscription_version", {
    p_subscription_id: input.subscriptionId,
    p_effective_from: input.effectiveFrom,
    p_new_price: input.newPrice,
    p_new_plan_end_date: input.newPlanEndDate,
    p_clear_end_date: input.clearEndDate,
    p_new_allowances: input.newAllowances ? allowancesRecordToArray(input.newAllowances) : null,
    p_confirmed: input.confirmed,
  });
  if (error) throw error;
  return data as RpcOutcome<{ action: "preview" | "applied" | "already_applied"; impact?: SubscriptionImpact; version_id?: string }>;
}

/**
 * Manager-only. Corrects plan_start_date for a subscription that has never been edited and has
 * zero billing/charge/payment/freeze/coverage history (see correct_subscription_start_date() —
 * returns ok:false/error:"has_history" for anything else; this function never recomputes
 * financial or coverage history, it only covers the one case where there is none to recompute).
 */
export async function rpcCorrectSubscriptionStartDate(
  supabase: SupabaseClient,
  subscriptionId: string,
  newStartDate: string
): Promise<RpcOutcome<{ plan_start_date: string; anchor_day: number }>> {
  const { data, error } = await supabase.rpc("correct_subscription_start_date", {
    p_subscription_id: subscriptionId,
    p_new_start_date: newStartDate,
  });
  if (error) throw error;
  return data as RpcOutcome<{ plan_start_date: string; anchor_day: number }>;
}

export type StartDateCorrectionCoverageChange = {
  registration_id: string | null;
  manual_participant_id: string | null;
  session_date: string;
  week_start: string;
  tier: string;
  new_covered: boolean;
  new_non_coverage_reason: string | null;
};

export type StartDateCorrectionOutcome = {
  action: "preview" | "applied";
  count: number;
  items: StartDateCorrectionCoverageChange[];
  new_anchor_day: number;
  /** Only present on action="applied". */
  plan_start_date?: string;
  anchor_day?: number;
};

/**
 * Scenario B of start-date correction (correct_subscription_start_date_for_new_subscriptions is
 * scenario A, zero-coverage-history only). Safe for a subscription with future registrations but
 * zero completed activity and zero billing/charge/payment/freeze history -- anything else returns
 * ok:false/error:"has_history". p_confirmed=false (default) always rolls back server-side and
 * returns a dry-run diff of exactly which coverage decisions would change; the caller must re-call
 * with confirmed=true (which re-validates eligibility fresh) to actually apply it.
 */
export async function rpcCorrectSubscriptionStartDateWithFutureRegistrations(
  supabase: SupabaseClient,
  subscriptionId: string,
  newStartDate: string,
  confirmed: boolean
): Promise<RpcOutcome<StartDateCorrectionOutcome>> {
  const { data, error } = await supabase.rpc("correct_subscription_start_date_with_future_registrations", {
    p_subscription_id: subscriptionId,
    p_new_start_date: newStartDate,
    p_confirmed: confirmed,
  });
  if (error) throw error;
  return data as RpcOutcome<StartDateCorrectionOutcome>;
}

export type FreezeSubscriptionOutcome = {
  action: "preview" | "applied" | "already_applied";
  impact?: SubscriptionImpact;
  freeze_id?: string;
  /** Only present on action="applied" -- the just-created freeze's own inclusive day count. */
  frozen_days?: number;
  /** Already reflects cumulative freeze shift -- never recompute this on the client. */
  next_billing_date?: string | null;
  /** Configured plan_end_date extended by every applicable freeze day; null iff no end date. */
  effective_plan_end_date?: string | null;
};

export async function rpcFreezeSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
  freezeFrom: string,
  freezeUntil: string,
  confirmed: boolean
): Promise<RpcOutcome<FreezeSubscriptionOutcome>> {
  const { data, error } = await supabase.rpc("freeze_subscription", {
    p_subscription_id: subscriptionId,
    p_freeze_from: freezeFrom,
    p_freeze_until: freezeUntil,
    p_confirmed: confirmed,
  });
  if (error) throw error;
  return data as RpcOutcome<FreezeSubscriptionOutcome>;
}

export type StopSubscriptionOutcome = {
  action: "preview" | "applied" | "already_applied";
  impact?: SubscriptionImpact;
  future_registrations?: FutureRegistrationItem[];
  future_registrations_count?: number;
  future_registrations_resolved?: number;
};

/** Extracted from a FutureRegistrationItem[] the caller already has (typically its own earlier
 * preview response) -- sent back on the confirmed call so the server can refuse to silently resolve
 * anything that wasn't in what the manager actually reviewed (error future_registrations_changed if
 * something new appeared since). */
export function futureRegistrationExpectedIds(items: FutureRegistrationItem[]): {
  registrationIds: string[];
  manualParticipantIds: string[];
} {
  return {
    registrationIds: items.map((i) => i.registration_id).filter((x): x is string => !!x),
    manualParticipantIds: items.map((i) => i.manual_participant_id).filter((x): x is string => !!x),
  };
}

export async function rpcStopSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
  stopDate: string,
  confirmed: boolean,
  futureRegistrationAction: FutureRegistrationAction | null = null,
  expectedFutureRegistrations: FutureRegistrationItem[] | null = null
): Promise<RpcOutcome<StopSubscriptionOutcome>> {
  const expected = expectedFutureRegistrations ? futureRegistrationExpectedIds(expectedFutureRegistrations) : null;
  const { data, error } = await supabase.rpc("stop_subscription_with_future_registrations", {
    p_subscription_id: subscriptionId,
    p_stop_date: stopDate,
    p_confirmed: confirmed,
    p_future_registration_action: futureRegistrationAction,
    p_expected_future_registration_ids: expected?.registrationIds ?? null,
    p_expected_future_manual_participant_ids: expected?.manualParticipantIds ?? null,
  });
  if (error) throw error;
  return data as RpcOutcome<StopSubscriptionOutcome>;
}

export type DeleteSubscriptionOutcome = {
  action: "preview" | "tombstoned" | "already_deleted";
  future_registrations?: FutureRegistrationItem[];
  future_registrations_count?: number;
  future_registrations_resolved?: number;
  reversed_charge_count?: number;
  reversed_total_ils?: number;
};

export async function rpcDeleteSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
  confirmed: boolean = false,
  futureRegistrationAction: FutureRegistrationAction | null = null,
  expectedFutureRegistrations: FutureRegistrationItem[] | null = null,
  expectedImpactFingerprint: string | null = null
): Promise<RpcOutcome<DeleteSubscriptionOutcome>> {
  const expected = expectedFutureRegistrations ? futureRegistrationExpectedIds(expectedFutureRegistrations) : null;
  const { data, error } = await supabase.rpc("delete_subscription_with_future_registrations", {
    p_subscription_id: subscriptionId,
    p_future_registration_action: futureRegistrationAction,
    p_confirmed: confirmed,
    p_expected_future_registration_ids: expected?.registrationIds ?? null,
    p_expected_future_manual_participant_ids: expected?.manualParticipantIds ?? null,
    p_expected_impact_fingerprint: expectedImpactFingerprint,
  });
  if (error) throw error;
  return data as RpcOutcome<DeleteSubscriptionOutcome>;
}

export async function rpcSubscriptionDeleteImpact(
  supabase: SupabaseClient,
  subscriptionId: string
): Promise<RpcOutcome<SubscriptionDeleteImpact>> {
  const { data, error } = await supabase.rpc("subscription_delete_impact", { p_subscription_id: subscriptionId });
  if (error) throw error;
  return data as RpcOutcome<SubscriptionDeleteImpact>;
}

export async function rpcListSubscriptionCorrections(
  supabase: SupabaseClient
): Promise<RpcOutcome<{ corrections: SubscriptionCorrection[]; accounting_confirmed: boolean }>> {
  const { data, error } = await supabase.rpc("manager_list_subscription_corrections", { p_pending_only: true });
  if (error) throw error;
  return data as RpcOutcome<{ corrections: SubscriptionCorrection[]; accounting_confirmed: boolean }>;
}

export async function rpcResolveSubscriptionCorrection(
  supabase: SupabaseClient,
  correctionId: string,
  decision: "applied_regular_price" | "kept_covered",
  reason: string,
  expectedPriceIls: number
): Promise<RpcOutcome<{ action: string; status?: string }>> {
  const { data, error } = await supabase.rpc("manager_resolve_subscription_correction", {
    p_correction_id: correctionId,
    p_decision: decision,
    p_reason: reason,
    p_expected_price: expectedPriceIls,
  });
  if (error) throw error;
  return data as RpcOutcome<{ action: string; status?: string }>;
}

export async function rpcUnfreezeSubscription(
  supabase: SupabaseClient,
  freezeId: string,
  confirmed: boolean
): Promise<RpcOutcome<UnfreezeOutcome>> {
  const { data, error } = await supabase.rpc("unfreeze_subscription", { p_freeze_id: freezeId, p_confirmed: confirmed });
  if (error) throw error;
  return data as RpcOutcome<UnfreezeOutcome>;
}

export async function rpcManagerSubscriptionWeekUtilization(
  supabase: SupabaseClient,
  weekStart: string
): Promise<SubscriptionWeekUtilization | RpcError> {
  const { data, error } = await supabase.rpc("manager_subscription_week_utilization", { p_week_start: weekStart });
  if (error) throw error;
  return data as SubscriptionWeekUtilization | RpcError;
}

/** The subscription a payment on this date may be recorded against. The server's rule, so this can't drift from it. */
export async function rpcSubscriptionPaymentTarget(
  supabase: SupabaseClient,
  payeeId: string,
  payeeIsManual: boolean,
  paidAt: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc("subscription_payment_target", {
    p_payee_id: payeeId,
    p_payee_is_manual: payeeIsManual,
    p_paid_at: paidAt,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function rpcReactivateSubscription(
  supabase: SupabaseClient,
  sourceSubscriptionId: string,
  startDate: string,
  endDate: string | null
): Promise<RpcOutcome<{ subscription_id: string; version_id: string }>> {
  const { data, error } = await supabase.rpc("reactivate_subscription", {
    p_source_subscription_id: sourceSubscriptionId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as RpcOutcome<{ subscription_id: string; version_id: string }>;
}
