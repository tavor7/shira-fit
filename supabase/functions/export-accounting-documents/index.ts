/**
 * Backup Management Phase 7: manager-only accounting-document export (CSV, or ZIP with PDFs +
 * a CSV summary). Manager-triggered (not cron) -- same Bearer-JWT + profiles.role==='manager'
 * auth pattern as send-document-email, not a service-role-only function.
 *
 * POST {
 *   format: "csv" | "zip",
 *   date_start?: string (ISO),   -- required unless full_history is true
 *   date_end?: string (ISO),     -- required unless full_history is true
 *   full_history?: boolean,      -- bypasses the date requirement; still subject to the row caps
 *                                   below -- an unfiltered full-history export of a large archive
 *                                   is refused with "too_many_rows", not silently truncated, so
 *                                   the caller narrows the range instead of getting a partial file
 *                                   that looks complete.
 *   status?: "ACTIVE" | "CANCELLED",  -- omit for both (cancellation records are included by
 *                                        default, per the brief -- this only narrows further)
 * }
 *
 * Row caps exist specifically so a request can never cause unbounded memory or execution time:
 * CSV has no PDFs to fetch, so its cap is generous; ZIP downloads one PDF per row from Storage
 * and buffers the whole archive (fflate's zipSync, not a stream) before responding, so its cap is
 * far smaller and bounds both the Storage fetch fan-out and the in-memory ZIP size.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zipSync } from "https://esm.sh/fflate@0.8.2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CSV_ROW_CAP = 20000;
const ZIP_ROW_CAP = 300;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type DocRow = {
  id: string;
  document_number: string;
  created_at: string;
  paid_at: string | null;
  customer_name: string;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
  payment_method: string | null;
  status: string;
  cancellation_reason: string | null;
  pdf_url: string | null;
};

/** UTF-8 BOM + CRLF, matching mobile/src/lib/csvExport.ts's own convention (Excel Hebrew compat). */
function buildCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers, ...rows].map((r) => r.map(esc).join(","));
  return "﻿" + lines.join("\r\n");
}

function docsToCsv(docs: DocRow[]): string {
  const headers = [
    "Document Number",
    "Date",
    "Paid At",
    "Customer",
    "Gross Amount",
    "Net Amount",
    "VAT Amount",
    "Payment Method",
    "Status",
    "Cancellation Reason",
  ];
  const rows = docs.map((d) => [
    d.document_number,
    d.created_at,
    d.paid_at ?? "",
    d.customer_name,
    String(d.gross_amount),
    String(d.net_amount),
    String(d.vat_amount),
    d.payment_method ?? "",
    d.status,
    d.cancellation_reason ?? "",
  ]);
  return buildCsv(headers, rows);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const admin = createClient(url, serviceKey);
  const { data: authData } = await admin.auth.getUser(token);
  const callerId = authData?.user?.id ?? null;
  if (!callerId) return json(401, { ok: false, error: "unauthorized" });

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("user_id", callerId).maybeSingle();
  if ((callerProfile as { role?: string } | null)?.role !== "manager") {
    return json(403, { ok: false, error: "forbidden" });
  }

  let body: {
    format?: string;
    date_start?: string;
    date_end?: string;
    full_history?: boolean;
    status?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const format = body.format === "zip" ? "zip" : body.format === "csv" ? "csv" : null;
  if (!format) return json(400, { ok: false, error: "format_required" });

  const fullHistory = body.full_history === true;
  if (!fullHistory && (!body.date_start || !body.date_end)) {
    return json(400, { ok: false, error: "date_range_required" });
  }
  if (body.status && body.status !== "ACTIVE" && body.status !== "CANCELLED") {
    return json(400, { ok: false, error: "invalid_status" });
  }

  const rowCap = format === "zip" ? ZIP_ROW_CAP : CSV_ROW_CAP;

  let query = admin
    .from("documents")
    .select(
      "id, document_number, created_at, paid_at, customer_name, gross_amount, net_amount, vat_amount, payment_method, status, cancellation_reason, pdf_url",
      { count: "exact" }
    )
    .order("created_at", { ascending: true })
    .limit(rowCap + 1); // +1 so we can distinguish "exactly the cap" from "more than the cap"

  if (body.date_start) query = query.gte("created_at", body.date_start);
  if (body.date_end) query = query.lte("created_at", body.date_end);
  if (body.status) query = query.eq("status", body.status);

  const { data, error, count } = await query;
  if (error) return json(500, { ok: false, error: "query_failed" });

  const docs = (data ?? []) as DocRow[];
  if (docs.length > rowCap) {
    return json(413, {
      ok: false,
      error: "too_many_rows",
      row_cap: rowCap,
      matched_count: count ?? null,
      message: `This export would include more than ${rowCap} documents. Narrow the date range and try again.`,
    });
  }

  if (format === "csv") {
    const csv = docsToCsv(docs);
    return new Response(csv, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="accounting-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // ZIP: one PDF per document (skipping any without a pdf_url rather than failing the whole
  // export -- a document that never got a PDF is noted in the CSV's own rows, which are still
  // included, so the gap is visible rather than hidden) + the same CSV as a summary file.
  const files: Record<string, Uint8Array> = {};
  for (const d of docs) {
    if (!d.pdf_url) continue;
    const { data: fileData, error: dlErr } = await admin.storage.from("document-pdfs").download(d.pdf_url);
    if (dlErr || !fileData) continue; // same "don't fail the whole export" reasoning as above
    files[`${d.document_number}.pdf`] = new Uint8Array(await fileData.arrayBuffer());
  }
  files["summary.csv"] = new TextEncoder().encode(docsToCsv(docs));

  const zipped = zipSync(files, { level: 6 });
  return new Response(zipped, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="accounting-export-${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
});
