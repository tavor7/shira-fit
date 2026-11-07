import type { BulkReceiptIssuePreview } from "./pendingReceipts";

/**
 * Text for the warning shown before a bulk issue, or null when no warning is needed.
 * Payments dated before an already-issued receipt still get receipts; they are numbered after it.
 */
export function bulkPredatingWarningMessage(template: string, preview: BulkReceiptIssuePreview): string | null {
  if (preview.predating_count <= 0) return null;
  return template
    .replace("{n}", String(preview.predating_count))
    .replace("{number}", preview.latest_issued_number ?? "—");
}

export type BulkIssueStep = { kind: "issue" } | { kind: "confirm"; message: string } | { kind: "blocked" };

/**
 * What happens after the pre-issue check: issue straight away, ask the manager to confirm older payments, or issue
 * nothing because the check itself failed (it must succeed before anything is numbered).
 */
export function bulkIssueStep(template: string, check: { ok: true; preview: BulkReceiptIssuePreview } | { ok: false }): BulkIssueStep {
  if (!check.ok) return { kind: "blocked" };
  const message = bulkPredatingWarningMessage(template, check.preview);
  return message ? { kind: "confirm", message } : { kind: "issue" };
}
