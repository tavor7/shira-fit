/** Parsed row from `staff_list_received_payments`. */

export type ReceivedPaymentSource = "account" | "session";

export type ReceivedPaymentSessionSlotKind = "arrival" | "no_show" | "cancellation" | "session";

export type StaffReceivedPaymentRow = {
  source: ReceivedPaymentSource;
  row_id: string;
  record_id: string;
  session_id: string | null;
  session_date: string | null;
  session_start_time: string | null;
  session_slot_kind: ReceivedPaymentSessionSlotKind | null;
  payee_id: string;
  payee_is_manual: boolean;
  amount_ils: number;
  payment_method: string | null;
  note: string | null;
  payer_name: string | null;
  paid_at: string;
  created_at: string;
  created_by: string | null;
};

export type StaffReceivedPaymentsPayload = {
  ok: boolean;
  error?: string;
  total_received: number;
  total_count: number;
  payments: StaffReceivedPaymentRow[];
};

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseSlotKind(raw: unknown): ReceivedPaymentSessionSlotKind | null {
  if (raw === "arrival" || raw === "no_show" || raw === "cancellation" || raw === "session") return raw;
  return null;
}

export function parseStaffReceivedPayments(raw: unknown): StaffReceivedPaymentsPayload {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_response", total_received: 0, total_count: 0, payments: [] };
  }
  const o = raw as Record<string, unknown>;
  if (o.ok === false) {
    return {
      ok: false,
      error: typeof o.error === "string" ? o.error : "unknown_error",
      total_received: 0,
      total_count: 0,
      payments: [],
    };
  }

  const paymentsRaw = o.payments;
  const payments: StaffReceivedPaymentRow[] = [];
  if (Array.isArray(paymentsRaw)) {
    for (const row of paymentsRaw) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const row_id = String(r.row_id ?? "");
      const record_id = String(r.record_id ?? "");
      const payee_id = String(r.payee_id ?? "");
      const paid_at = String(r.paid_at ?? "");
      if (!row_id || !record_id || !payee_id || !paid_at) continue;
      payments.push({
        source: r.source === "session" ? "session" : "account",
        row_id,
        record_id,
        session_id: r.session_id == null ? null : String(r.session_id),
        session_date: r.session_date == null ? null : String(r.session_date),
        session_start_time: r.session_start_time == null ? null : String(r.session_start_time),
        session_slot_kind: parseSlotKind(r.session_slot_kind),
        payee_id,
        payee_is_manual: Boolean(r.payee_is_manual),
        amount_ils: num(r.amount_ils),
        payment_method: r.payment_method == null ? null : String(r.payment_method),
        note: r.note == null ? null : String(r.note),
        payer_name: r.payer_name == null ? null : String(r.payer_name),
        paid_at,
        created_at: String(r.created_at ?? paid_at),
        created_by: r.created_by == null ? null : String(r.created_by),
      });
    }
  }

  return {
    ok: true,
    total_received: num(o.total_received),
    total_count: num(o.total_count),
    payments,
  };
}
