/**
 * Athlete Activity (ParticipantHistoryScreen) load outcome. A failed request must never look like a successful empty
 * result: when a lookup that the amounts depend on fails, the report shows an error (or, on a background refresh, keeps
 * the previous figures marked as out of date) instead of totals computed from missing data.
 */

/** Lookups whose data feeds the balance, the expected / received totals, per-session prices or "covered" statuses. */
export type ParticipantHistoryRequiredLookup =
  | "family"
  | "history"
  | "globalTiers"
  | "payments"
  | "athleteTiers"
  | "subscriptionCharges"
  | "coverage"
  | "sessionPrices"
  | "rosterPrices";

/** Lookups that only add details; the report stays correct without them, but must say what is missing. */
export type ParticipantHistoryDetailLookup = "receipts" | "staffNames" | "hiddenKeys";

export type ParticipantHistoryLookup = ParticipantHistoryRequiredLookup | ParticipantHistoryDetailLookup;

const DETAIL_LOOKUPS: ReadonlySet<ParticipantHistoryLookup> = new Set<ParticipantHistoryDetailLookup>([
  "receipts",
  "staffNames",
  "hiddenKeys",
]);

export function isRequiredLookup(name: ParticipantHistoryLookup): name is ParticipantHistoryRequiredLookup {
  return !DETAIL_LOOKUPS.has(name);
}

export type LookupFailure = { lookup: ParticipantHistoryLookup; message: string };

/** Splits failures into those that make the report unusable and those that only leave details missing. */
export function classifyLookupFailures(failures: readonly LookupFailure[]): {
  blocking: LookupFailure[];
  missingDetails: ParticipantHistoryDetailLookup[];
} {
  const blocking = failures.filter((f) => isRequiredLookup(f.lookup));
  const missingDetails = [
    ...new Set(failures.map((f) => f.lookup).filter((l): l is ParticipantHistoryDetailLookup => !isRequiredLookup(l))),
  ];
  return { blocking, missingDetails };
}

/** Collects `{ error }` results (Supabase responses or our own result objects) into failures; `null` means "not requested". */
export function lookupFailures(
  results: Partial<Record<ParticipantHistoryLookup, object | null>>
): LookupFailure[] {
  const out: LookupFailure[] = [];
  for (const [lookup, res] of Object.entries(results) as [ParticipantHistoryLookup, { error?: unknown } | null][]) {
    const err = res?.error;
    if (err == null) continue;
    const message = typeof err === "string" ? err : (err as { message?: string }).message || lookup;
    out.push({ lookup, message });
  }
  return out;
}

/**
 * What the screen shows after a load:
 * - `ok`: everything required loaded (details may still be missing → `missingDetails`).
 * - `failed`: required data is missing and there is nothing trustworthy to show — no rows, no totals, an error + retry.
 * - `stale`: a background refresh failed while a complete earlier report is on screen — it stays, marked out of date.
 */
export type ParticipantHistoryReportState =
  | { kind: "ok"; missingDetails: ParticipantHistoryDetailLookup[] }
  | { kind: "failed"; message: string }
  | { kind: "stale"; message: string };

export function reportStateAfterLoad(
  failures: readonly LookupFailure[],
  opts: { silent: boolean; hasCompleteReport: boolean }
): ParticipantHistoryReportState {
  const { blocking, missingDetails } = classifyLookupFailures(failures);
  if (blocking.length === 0) return { kind: "ok", missingDetails };
  const message = blocking.map((f) => f.message).join(" · ");
  return opts.silent && opts.hasCompleteReport ? { kind: "stale", message } : { kind: "failed", message };
}
