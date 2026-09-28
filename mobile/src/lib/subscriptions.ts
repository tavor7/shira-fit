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

export type ImpactRegistrationItem = {
  registration_id: string | null;
  manual_participant_id: string | null;
  session_date: string;
  week_start: string;
  tier: SubscriptionTier;
  new_non_coverage_reason: string | null;
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
export type RpcError = { ok: false; error: string; subscription_id?: string };
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

export async function rpcCreateSubscription(
  supabase: SupabaseClient,
  input: CreateSubscriptionInput
): Promise<RpcOutcome<{ subscription_id: string; version_id: string }>> {
  const { data, error } = await supabase.rpc("create_subscription", {
    p_payee_id: input.payeeId,
    p_payee_is_manual: input.payeeIsManual,
    p_monthly_price_ils: input.monthlyPriceIls,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_anchor_day: null,
    p_allowances: allowancesRecordToArray(input.allowances),
  });
  if (error) throw error;
  return data as RpcOutcome<{ subscription_id: string; version_id: string }>;
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

export async function rpcStopSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
  stopDate: string,
  confirmed: boolean
): Promise<RpcOutcome<{ action: "preview" | "applied" | "already_applied"; impact?: SubscriptionImpact }>> {
  const { data, error } = await supabase.rpc("stop_subscription", {
    p_subscription_id: subscriptionId,
    p_stop_date: stopDate,
    p_confirmed: confirmed,
  });
  if (error) throw error;
  return data as RpcOutcome<{ action: "preview" | "applied" | "already_applied"; impact?: SubscriptionImpact }>;
}

export async function rpcDeleteSubscription(
  supabase: SupabaseClient,
  subscriptionId: string
): Promise<RpcOutcome<{ action: "tombstoned" }>> {
  const { data, error } = await supabase.rpc("delete_subscription", { p_subscription_id: subscriptionId });
  if (error) throw error;
  return data as RpcOutcome<{ action: "tombstoned" }>;
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
