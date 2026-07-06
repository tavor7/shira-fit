import { supabase } from "./supabase";
import type { DocumentPaymentMethodKey } from "./documentPaymentMethod";
import type { DocumentServiceTypeKey } from "./documentServiceTypes";

export type ReceiptSettings = {
  id: string;
  business_id: string;
  business_name: string;
  address: string;
  phone: string;
  email: string;
  accountant_email: string;
  digital_receipts_enabled: boolean;
  vat_rate: number;
  document_prefix: string;
  next_document_number: number;
  staff_can_cancel_documents: boolean;
  is_operational: boolean;
  request_address_from_existing_users: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DocumentStatus = "ACTIVE" | "CANCELLED" | "NEEDS_PAYMENT_METHOD";
export type DocumentSourceType = "account_payment" | "session_payment" | "cancellation_penalty" | "manual";

export type DocumentCustomerType = "regular" | "manual" | "family";

export type DocumentRow = {
  id: string;
  document_number: string;
  customer_id: string;
  customer_profile_user_id?: string | null;
  customer_manual_participant_id?: string | null;
  customer_type?: DocumentCustomerType | null;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
  vat_rate: number;
  currency: string;
  payment_method: DocumentPaymentMethodKey | null;
  service_type: DocumentServiceTypeKey;
  service_description: string | null;
  notes: string | null;
  status: DocumentStatus;
  pdf_url: string | null;
  signature_hash: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address?: string;
  customer_zip_code?: string;
  business_name: string;
  sent_at: string | null;
  delivery_status: string | null;
  recipient_email: string | null;
  send_count: number;
  source_type: DocumentSourceType | null;
  source_id: string | null;
};

export type DocumentReportRow = {
  document_number: string;
  created_at: string;
  customer_name: string;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
  vat_rate: number;
  payment_method: DocumentPaymentMethodKey | null;
  service_type: DocumentServiceTypeKey;
  service_description: string | null;
  status: DocumentStatus;
};

export type RequiredConsent = {
  consent_type: string;
  version: number;
  title: string;
  body_text: string;
};

export type GoLiveGapType = "address" | "zip" | "consent";

export type GoLiveGapRow = {
  user_id: string;
  full_name: string;
  username: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  zip_code: string | null;
  consent_version: number | null;
};

export type GoLiveStats = {
  missing_address_count: number;
  missing_zip_count: number;
  missing_consent_count: number;
  current_consent_version: number;
};

type RpcOk<T> = { ok: true } & T;
type RpcErr = { ok: false; error: string };

function parseRpc<T extends Record<string, unknown>>(data: unknown): RpcOk<T> | RpcErr {
  const row = data as RpcOk<T> | RpcErr | null;
  if (!row || typeof row !== "object") return { ok: false, error: "invalid_response" };
  if (!row.ok) return { ok: false, error: (row as RpcErr).error ?? "unknown" };
  return row as RpcOk<T>;
}

export async function fetchReceiptSettings(): Promise<ReceiptSettings | null> {
  const { data, error } = await supabase.rpc("get_receipt_settings");
  if (error) throw error;
  const parsed = parseRpc<{ settings: ReceiptSettings }>(data);
  if (!parsed.ok) return null;
  return parsed.settings;
}

export async function updateReceiptSettings(patch: Partial<{
  business_id: string;
  business_name: string;
  address: string;
  phone: string;
  email: string;
  accountant_email: string;
  digital_receipts_enabled: boolean;
  vat_rate: number;
  document_prefix: string;
  staff_can_cancel_documents: boolean;
  is_operational: boolean;
  request_address_from_existing_users: boolean;
}>): Promise<ReceiptSettings> {
  const { data, error } = await supabase.rpc("update_receipt_settings", {
    p_business_id: patch.business_id ?? null,
    p_business_name: patch.business_name ?? null,
    p_address: patch.address ?? null,
    p_phone: patch.phone ?? null,
    p_email: patch.email ?? null,
    p_accountant_email: patch.accountant_email ?? null,
    p_digital_receipts_enabled: patch.digital_receipts_enabled ?? null,
    p_vat_rate: patch.vat_rate ?? null,
    p_document_prefix: patch.document_prefix ?? null,
    p_staff_can_cancel_documents: patch.staff_can_cancel_documents ?? null,
    p_is_operational: patch.is_operational ?? null,
    p_request_address_from_existing_users: patch.request_address_from_existing_users ?? null,
  });
  if (error) throw error;
  const parsed = parseRpc<{ settings: ReceiptSettings }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.settings;
}

export async function createDocument(input: {
  gross_amount: number;
  service_type: DocumentServiceTypeKey;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  payment_method?: DocumentPaymentMethodKey | null;
  service_description?: string | null;
  notes?: string | null;
  profile_user_id?: string | null;
  manual_participant_id?: string | null;
  source_type?: DocumentSourceType;
  source_id?: string | null;
  source_payment_method?: string | null;
}): Promise<{ document_id: string; document_number: string; status: DocumentStatus; needs_pdf: boolean }> {
  const { data, error } = await supabase.rpc("create_document", {
    p_gross_amount: input.gross_amount,
    p_service_type: input.service_type,
    p_customer_name: input.customer_name,
    p_customer_email: input.customer_email ?? null,
    p_customer_phone: input.customer_phone ?? null,
    p_payment_method: input.payment_method ?? null,
    p_service_description: input.service_description ?? null,
    p_notes: input.notes ?? null,
    p_profile_user_id: input.profile_user_id ?? null,
    p_manual_participant_id: input.manual_participant_id ?? null,
    p_source_type: input.source_type ?? "manual",
    p_source_id: input.source_id ?? null,
    p_source_payment_method: input.source_payment_method ?? null,
  });
  if (error) throw error;
  const parsed = parseRpc<{
    document_id: string;
    document_number: string;
    status: DocumentStatus;
    needs_pdf: boolean;
  }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    document_id: parsed.document_id,
    document_number: parsed.document_number,
    status: parsed.status,
    needs_pdf: parsed.needs_pdf,
  };
}

export async function listDocuments(opts?: {
  date_start?: string | null;
  date_end?: string | null;
  status?: DocumentStatus | null;
  customer_type?: DocumentCustomerType | null;
  limit?: number;
  offset?: number;
}): Promise<{ rows: DocumentRow[]; total: number }> {
  const { data, error } = await supabase.rpc("list_documents", {
    p_date_start: opts?.date_start ?? null,
    p_date_end: opts?.date_end ?? null,
    p_status: opts?.status ?? null,
    p_customer_type: opts?.customer_type ?? null,
    p_limit: opts?.limit ?? 200,
    p_offset: opts?.offset ?? 0,
  });
  if (error) throw error;
  const parsed = parseRpc<{ rows: DocumentRow[]; total: number }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return { rows: parsed.rows ?? [], total: parsed.total ?? 0 };
}

export async function setDocumentPaymentMethod(
  documentId: string,
  method: DocumentPaymentMethodKey
): Promise<{ needs_pdf: boolean }> {
  const { data, error } = await supabase.rpc("set_document_payment_method", {
    p_document_id: documentId,
    p_payment_method: method,
  });
  if (error) throw error;
  const parsed = parseRpc<{ needs_pdf: boolean }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return { needs_pdf: parsed.needs_pdf };
}

export async function cancelDocument(documentId: string, reason: string): Promise<void> {
  const { data, error } = await supabase.rpc("cancel_document", {
    p_document_id: documentId,
    p_reason: reason,
  });
  if (error) throw error;
  const parsed = parseRpc<Record<string, never>>(data);
  if (!parsed.ok) throw new Error(parsed.error);
}

export async function prepareDocumentPdfRegeneration(documentId: string): Promise<void> {
  const { data, error } = await supabase.rpc("prepare_document_pdf_regeneration", {
    p_document_id: documentId,
  });
  if (error) throw error;
  const parsed = parseRpc<Record<string, never>>(data);
  if (!parsed.ok) throw new Error(parsed.error);
}

export async function logDocumentEvent(
  documentId: string,
  action: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await supabase.rpc("log_document_event", {
    p_document_id: documentId,
    p_action: action,
    p_metadata: metadata ?? {},
  });
}

export async function fetchDocumentReport(
  dateStart?: string | null,
  dateEnd?: string | null
): Promise<DocumentReportRow[]> {
  const { data, error } = await supabase.rpc("document_report", {
    p_date_start: dateStart ?? null,
    p_date_end: dateEnd ?? null,
  });
  if (error) throw error;
  const parsed = parseRpc<{ rows: DocumentReportRow[] }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rows ?? [];
}

export async function getDocumentPdfSignedUrl(pdfPath: string, cacheKey?: string | null): Promise<string> {
  const { data, error } = await supabase.storage.from("document-pdfs").createSignedUrl(pdfPath, 3600);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error("signed_url_failed");
  const bust = encodeURIComponent(cacheKey ?? String(Date.now()));
  const sep = data.signedUrl.includes("?") ? "&" : "?";
  return `${data.signedUrl}${sep}cb=${bust}`;
}

export function documentPdfStoragePath(documentId: string, documentNumber: string): string {
  return `documents/${documentId}/${documentNumber}.pdf`;
}

export async function fetchDocumentCustomerEmail(documentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("customer_email")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  return data?.customer_email?.trim() || null;
}

export async function autoGenerateDocumentPdfIfReady(
  documentId: string,
  status: DocumentStatus,
  opts?: { needsPdf?: boolean; allowOverwrite?: boolean }
): Promise<void> {
  if (status === "NEEDS_PAYMENT_METHOD") return;
  if (opts?.needsPdf === false) return;
  try {
    await invokeGenerateDocumentPdf(documentId, opts?.allowOverwrite ?? false);
  } catch {
    /* PDF can be regenerated later from the hub */
  }
}

export async function fetchGoLiveStats(): Promise<GoLiveStats> {
  const { data, error } = await supabase.rpc("get_receipt_go_live_stats");
  if (error) throw error;
  const parsed = parseRpc<GoLiveStats>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    missing_address_count: parsed.missing_address_count ?? 0,
    missing_zip_count: parsed.missing_zip_count ?? 0,
    missing_consent_count: parsed.missing_consent_count ?? 0,
    current_consent_version: parsed.current_consent_version ?? 0,
  };
}

export async function listGoLiveGaps(gapType: GoLiveGapType): Promise<GoLiveGapRow[]> {
  const { data, error } = await supabase.rpc("list_receipt_go_live_gaps", { p_gap_type: gapType });
  if (error) throw error;
  const parsed = parseRpc<{ rows: GoLiveGapRow[] }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rows ?? [];
}

export async function updateDocumentCustomerEmail(documentId: string, email: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("update_document_customer_email", {
    p_document_id: documentId,
    p_email: email,
  });
  if (error) throw error;
  const parsed = parseRpc<{ customer_email: string | null }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.customer_email ?? null;
}

export async function invokeGenerateDocumentPdf(documentId: string, allowOverwrite = false): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("generate-document-pdf", {
    body: { document_id: documentId, allow_overwrite: allowOverwrite },
  });
  const row = (data ?? null) as { ok?: boolean; error?: string; signature_hash?: string } | null;
  if (error) {
    const contextBody =
      typeof error === "object" && error !== null && "context" in error
        ? String((error as { context?: { body?: string } }).context?.body ?? "")
        : "";
    const msg = row?.error || contextBody || error.message || "pdf_generation_failed";
    throw new Error(msg.trim() || "pdf_generation_failed");
  }
  if (!row?.ok) throw new Error(row?.error ?? "pdf_generation_failed");
  return row.signature_hash ?? null;
}

export type SendDocumentsEmailResult = {
  emails_sent: number;
  documents_sent: number;
  skipped_no_email?: number;
};

export async function invokeSendDocumentEmail(documentId: string, recipientEmail: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("send-document-email", {
    body: { document_id: documentId, recipient_email: recipientEmail },
  });
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string };
  if (!row?.ok) throw new Error(row?.error ?? "email_send_failed");
}

export async function invokeSendDocumentsEmail(opts: {
  documentIds: string[];
  mode: "accountant" | "customers";
  recipientEmail?: string;
}): Promise<SendDocumentsEmailResult> {
  const ids = opts.documentIds.filter(Boolean);
  if (ids.length === 0) return { emails_sent: 0, documents_sent: 0 };

  const body: Record<string, unknown> = { document_ids: ids };
  if (opts.mode === "customers") {
    body.mode = "customers";
  } else {
    if (!opts.recipientEmail?.trim()) throw new Error("missing_recipient");
    body.recipient_email = opts.recipientEmail.trim();
  }

  const { data, error } = await supabase.functions.invoke("send-document-email", { body });
  if (error) throw error;
  const row = data as {
    ok?: boolean;
    error?: string;
    emails_sent?: number;
    documents_sent?: number;
    skipped_no_email?: number;
  };
  if (!row?.ok) throw new Error(row?.error ?? "email_send_failed");
  return {
    emails_sent: row.emails_sent ?? 0,
    documents_sent: row.documents_sent ?? 0,
    skipped_no_email: row.skipped_no_email,
  };
}

export async function publishLegalDocument(
  consentType: "electronic_receipts" | "terms_of_service" | "privacy_policy",
  title: string,
  bodyText: string
): Promise<number> {
  const { data, error } = await supabase.rpc("publish_legal_document", {
    p_consent_type: consentType,
    p_title: title,
    p_body_text: bodyText,
  });
  if (error) throw error;
  const parsed = parseRpc<{ version: number }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.version;
}

export function formatIls(amount: number | string | null | undefined): string {
  const n = typeof amount === "number" ? amount : Number.parseFloat(String(amount ?? "0"));
  if (!Number.isFinite(n)) return "₪0.00";
  return `₪${n.toFixed(2)}`;
}

export function vatPercentLabel(rate: number): string {
  return `${Math.round(rate * 10000) / 100}%`;
}

export async function createDocumentWithPayment(input: {
  mode: "account";
  gross_amount: number;
  service_type: DocumentServiceTypeKey;
  payment_method: DocumentPaymentMethodKey;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  service_description?: string | null;
  notes?: string | null;
  profile_user_id?: string | null;
  manual_participant_id?: string | null;
  paid_at?: string | null;
}): Promise<{
  document_id: string;
  document_number: string;
  status: DocumentStatus;
  needs_pdf: boolean;
}> {
  const { data, error } = await supabase.rpc("create_document_with_payment", {
    p_mode: input.mode,
    p_gross_amount: input.gross_amount,
    p_service_type: input.service_type,
    p_payment_method: input.payment_method,
    p_customer_name: input.customer_name,
    p_customer_email: input.customer_email ?? null,
    p_customer_phone: input.customer_phone ?? null,
    p_service_description: input.service_description ?? null,
    p_notes: input.notes ?? null,
    p_profile_user_id: input.profile_user_id ?? null,
    p_manual_participant_id: input.manual_participant_id ?? null,
    p_session_id: null,
    p_paid_at: input.paid_at ?? null,
    p_record_payment: true,
  });
  if (error) throw new Error(error.message);
  const parsed = parseRpc<{
    document_id: string;
    document_number: string;
    status: DocumentStatus;
    needs_pdf: boolean;
  }>(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    document_id: parsed.document_id,
    document_number: parsed.document_number,
    status: parsed.status,
    needs_pdf: parsed.needs_pdf,
  };
}

