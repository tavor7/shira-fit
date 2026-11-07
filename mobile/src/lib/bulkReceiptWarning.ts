import type { BulkReceiptIssuePreview } from "./pendingReceipts";

/**
 * Text for the non-blocking warning shown before a bulk issue, or null when no warning is needed.
 * Payments dated before an already-issued receipt still get receipts; they are numbered after it.
 */
export function bulkPredatingWarningMessage(template: string, preview: BulkReceiptIssuePreview): string | null {
  if (preview.predating_count <= 0) return null;
  return template
    .replace("{n}", String(preview.predating_count))
    .replace("{number}", preview.latest_issued_number ?? "—");
}
