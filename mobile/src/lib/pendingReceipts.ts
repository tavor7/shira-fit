import { supabase } from "./supabase";
import type { DocumentStatus } from "./documents";

export type PendingReceiptRowKind = "account" | "session_reg" | "session_manual" | "cancellation";

export type PendingReceiptPayment = {
  row_id: string;
  row_kind: PendingReceiptRowKind;
  source: "account" | "session";
  record_id: string;
  session_id: string | null;
  session_date: string | null;
  session_start_time: string | null;
  session_slot_kind: string | null;
  payee_id: string;
  payee_is_manual: boolean;
  payee_name: string;
  payee_phone: string | null;
  amount_ils: number;
  payment_method: string | null;
  note: string | null;
  paid_at: string;
  coach_name: string | null;
  service_type: string;
  needs_payment_method: boolean;
};

export type CreateDocumentsFromPaymentsResult = {
  created_count: number;
  failed_count: number;
  created: Array<{
    row_id: string;
    document_id: string;
    document_number: string;
    status: DocumentStatus;
    needs_pdf: boolean;
  }>;
  failed: Array<{ row_id?: string; error?: string }>;
};

function parseRpc<T extends Record<string, unknown>>(raw: unknown): T {
  if (!raw || typeof raw !== "object") throw new Error("invalid_response");
  const o = raw as T & { ok?: boolean; error?: string };
  if (o.ok === false) throw new Error(o.error ?? "unknown_error");
  return o;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseRowKind(raw: unknown): PendingReceiptRowKind {
  if (raw === "account" || raw === "session_reg" || raw === "session_manual" || raw === "cancellation") {
    return raw;
  }
  return "account";
}

export async function listPaymentsWithoutReceipt(opts?: {
  date_start?: string | null;
  date_end?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ payments: PendingReceiptPayment[]; total_count: number; total_amount: number }> {
  const { data, error } = await supabase.rpc("staff_list_payments_without_receipt", {
    p_date_start: opts?.date_start ?? null,
    p_date_end: opts?.date_end ?? null,
    p_limit: opts?.limit ?? 500,
    p_offset: opts?.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  const parsed = parseRpc<{
    payments: unknown[];
    total_count: number;
    total_amount: number;
  }>(data);

  const payments: PendingReceiptPayment[] = [];
  if (Array.isArray(parsed.payments)) {
    for (const row of parsed.payments) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const row_id = String(r.row_id ?? "");
      if (!row_id) continue;
      payments.push({
        row_id,
        row_kind: parseRowKind(r.row_kind),
        source: r.source === "session" ? "session" : "account",
        record_id: String(r.record_id ?? ""),
        session_id: r.session_id == null ? null : String(r.session_id),
        session_date: r.session_date == null ? null : String(r.session_date),
        session_start_time: r.session_start_time == null ? null : String(r.session_start_time),
        session_slot_kind: r.session_slot_kind == null ? null : String(r.session_slot_kind),
        payee_id: String(r.payee_id ?? ""),
        payee_is_manual: Boolean(r.payee_is_manual),
        payee_name: String(r.payee_name ?? ""),
        payee_phone: r.payee_phone == null ? null : String(r.payee_phone),
        amount_ils: num(r.amount_ils),
        payment_method: r.payment_method == null ? null : String(r.payment_method),
        note: r.note == null ? null : String(r.note),
        paid_at: String(r.paid_at ?? ""),
        coach_name: r.coach_name == null ? null : String(r.coach_name),
        service_type: String(r.service_type ?? "other"),
        needs_payment_method: Boolean(r.needs_payment_method),
      });
    }
  }

  return {
    payments,
    total_count: num(parsed.total_count),
    total_amount: num(parsed.total_amount),
  };
}

export async function createDocumentsFromPayments(rowIds: string[]): Promise<CreateDocumentsFromPaymentsResult> {
  const { data, error } = await supabase.rpc("create_documents_from_payments", {
    p_row_ids: rowIds,
  });
  if (error) throw error;
  const parsed = parseRpc<{
    created_count: number;
    failed_count: number;
    created: unknown;
    failed: unknown;
  }>(data);

  const created: CreateDocumentsFromPaymentsResult["created"] = [];
  if (Array.isArray(parsed.created)) {
    for (const item of parsed.created) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      created.push({
        row_id: String(o.row_id ?? ""),
        document_id: String(o.document_id ?? ""),
        document_number: String(o.document_number ?? ""),
        status: String(o.status ?? "") as DocumentStatus,
        needs_pdf: Boolean(o.needs_pdf),
      });
    }
  }

  const failed: CreateDocumentsFromPaymentsResult["failed"] = [];
  if (Array.isArray(parsed.failed)) {
    for (const item of parsed.failed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      failed.push({
        row_id: o.row_id == null ? undefined : String(o.row_id),
        error: o.error == null ? undefined : String(o.error),
      });
    }
  }

  return {
    created_count: num(parsed.created_count),
    failed_count: num(parsed.failed_count),
    created,
    failed,
  };
}
