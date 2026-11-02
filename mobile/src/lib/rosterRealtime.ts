import type { RealtimeChange } from "../hooks/useRealtimeRefetch";

/** Tables whose changes can alter a session roster. */
export const ROSTER_TABLES = new Set(["session_registrations", "session_manual_participants", "cancellations"]);

/** What the roster shows for one row (the fields an attendance / payment change can alter). */
export type RosterRowState = {
  id: string; // "u:<user id>" | "m:<manual participant id>"
  attended: boolean | null;
  chargeNoShow: boolean;
  paymentMethod: string | null;
  amountPaid: number | null;
};

function amount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function sameAsShown(row: RosterRowState | undefined, n: Record<string, unknown>): boolean {
  if (!row) return false;
  const attended = n.attended === true ? true : n.attended === false ? false : null;
  const method = typeof n.payment_method === "string" ? n.payment_method : null;
  return (
    row.attended === attended &&
    row.chargeNoShow === (n.charge_no_show === true) &&
    row.paymentMethod === method &&
    row.amountPaid === amount(n.amount_paid)
  );
}

/**
 * Performance Phase 4: whether a batch of realtime changes can make the roster on screen out of date.
 *
 * The roster already reloads itself right after its own attendance / payment writes; the realtime echo of that same
 * write used to reload it a second time. A change is "news" unless it is an UPDATE of a registration (still active) or
 * walk-in that is on screen and whose shown fields (attended, no-show charge, payment method, amount) already equal the
 * row's new values - such an update cannot change anything the roster shows or derives from these fields. Anything
 * else is news: inserts, deletes, cancellations, status changes, rows not on screen, unknown changes (`null`).
 * Independent of who made the change and of clocks.
 */
export function rosterChangesAreNews(changes: RealtimeChange[] | null, shown: RosterRowState[]): boolean {
  if (changes === null) return true;
  const byId = new Map(shown.map((r) => [r.id, r]));
  for (const c of changes) {
    if (!ROSTER_TABLES.has(c.table)) continue;
    if (c.table === "cancellations" || c.eventType !== "UPDATE" || !c.new) return true;
    if (c.table === "session_registrations") {
      if (c.new.status !== "active" || typeof c.new.user_id !== "string") return true;
      if (!sameAsShown(byId.get(`u:${c.new.user_id}`), c.new)) return true;
    } else {
      if (typeof c.new.manual_participant_id !== "string") return true;
      if (!sameAsShown(byId.get(`m:${c.new.manual_participant_id}`), c.new)) return true;
    }
  }
  return false;
}
