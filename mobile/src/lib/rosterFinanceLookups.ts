/**
 * Session roster (ParticipantAttendanceList) financial lookups. A failed lookup is not an empty result: a failed coverage
 * check is not "nobody is covered", a failed receipt-lock check is not "nothing is locked", a failed price is not ₪0.
 * The roster says what it could not load and stops presenting figures or offering actions that depend on it.
 */
import { isSessionPaymentRecorded } from "./paymentMethod";

/** Which financial lookups failed on the last roster load (true = unknown, not "none"). */
export type RosterFinanceUnknown = {
  /** session_subscription_coverage — which rows are covered by a subscription. */
  coverage: boolean;
  /** session_payment_receipt_locks — which recorded payments have a receipt (read-only). */
  locks: boolean;
  /** Billing prices (batch or per row) — amounts due and the expected total. */
  prices: boolean;
  /** session_roster_slot_prices — per-athlete price overrides shown / edited by the rate editor. */
  rates: boolean;
  /** One of the participant lists (app or walk-in) failed: the roster and its totals are incomplete. */
  participants: boolean;
};

export const NO_UNKNOWN_FINANCE: RosterFinanceUnknown = {
  coverage: false,
  locks: false,
  prices: false,
  rates: false,
  participants: false,
};

/**
 * An `{ ok, ... }` RPC result failed when the request errored or the function answered `ok: false` for any reason other
 * than `forbidden` (a viewer who may not see this session's finance — by design; handled as before, nothing shown).
 */
export function rpcLookupFailed(res: { error?: unknown; data?: unknown } | null | undefined): boolean {
  if (!res || res.error) return true;
  const data = res.data as { ok?: boolean; error?: string } | null | undefined;
  if (data?.ok === true) return false;
  return data?.error !== "forbidden";
}

export function anyFinanceUnknown(u: RosterFinanceUnknown): boolean {
  return u.coverage || u.locks || u.prices || u.rates || u.participants;
}

/** The expected amount to collect depends on coverage, prices and the full participant list. */
export function expectedTotalUnknown(u: RosterFinanceUnknown): boolean {
  return u.coverage || u.prices || u.participants;
}

/**
 * With receipt locks unknown, a row that already has a recorded payment may be receipted (read-only): pause editing it.
 * Rows without a recorded payment cannot have a receipt.
 */
export function paymentLockUnknown(
  u: RosterFinanceUnknown,
  row: { paymentMethod: string | null; amountPaid: number | null },
  knownLocked: boolean
): boolean {
  if (!u.locks || knownLocked) return false;
  return row.amountPaid != null || isSessionPaymentRecorded(row.paymentMethod);
}

/** The list of unknown items, in display order, for the roster's notice. */
export function unknownFinanceItems(u: RosterFinanceUnknown): (keyof RosterFinanceUnknown)[] {
  return (["participants", "coverage", "prices", "locks", "rates"] as const).filter((k) => u[k]);
}
