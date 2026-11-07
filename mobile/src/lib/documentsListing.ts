import type { DocumentRow, DocumentSourceType } from "./documents";

export const DOCUMENTS_PAGE_SIZE = 200;

export type PayeeFilter = { type: "all" } | { type: "app" | "manual"; id: string; label: string };

/** list_documents arguments for a payee filter. The filter must reach the server: paging first and filtering after hides older matches. */
export function payeeFilterArgs(filter: PayeeFilter): { profile_user_id: string | null; manual_participant_id: string | null } {
  if (filter.type === "app") return { profile_user_id: filter.id, manual_participant_id: null };
  if (filter.type === "manual") return { profile_user_id: null, manual_participant_id: filter.id };
  return { profile_user_id: null, manual_participant_id: null };
}

export type DocumentsListState = "loading" | "error" | "empty" | "ready";

export function documentsListState(s: { loading: boolean; error: boolean; count: number }): DocumentsListState {
  if (s.loading) return "loading";
  if (s.error) return "error";
  return s.count === 0 ? "empty" : "ready";
}

export function hasMoreDocuments(loaded: number, total: number): boolean {
  return loaded < total;
}

/** Appends a later page, skipping rows already shown (a document issued between page loads shifts the offsets by one). */
export function appendDocumentsPage(current: DocumentRow[], page: DocumentRow[]): DocumentRow[] {
  const seen = new Set(current.map((d) => d.id));
  return [...current, ...page.filter((d) => !seen.has(d.id))];
}

/**
 * Newest first by the listed date, ties broken by document number: the same order list_documents pages in.
 * The listed date is the payment date (see documentDateKind), not the issue date, so numbers need not follow it.
 */
export function sortDocuments(rows: DocumentRow[], order: "asc" | "desc"): DocumentRow[] {
  return [...rows].sort((a, b) => {
    const aTime = new Date(a.paid_at).getTime();
    const bTime = new Date(b.paid_at).getTime();
    if (aTime !== bTime) return order === "asc" ? aTime - bTime : bTime - aTime;
    const cmp = a.document_number.localeCompare(b.document_number);
    return order === "asc" ? cmp : -cmp;
  });
}

/** What the listed date (paid_at, from _document_payment_paid_at) actually is for each kind of document. */
export function documentDateKind(source: DocumentSourceType | null): "session" | "payment" | "cancellation" | "issued" {
  if (source === "session_payment") return "session";
  if (source === "account_payment") return "payment";
  if (source === "cancellation_penalty") return "cancellation";
  return "issued";
}
