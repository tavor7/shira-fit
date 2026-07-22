/**
 * Generate a Hebrew RTL monthly summary PDF (business details + total revenue for the
 * accountant) covering all ACTIVE receipts in a date range. Uploads to Storage and
 * records the run in `monthly_summaries`.
 * POST { period_start, period_end }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, type PDFFont } from "npm:pdf-lib@1.17.1";
import fontkitImport from "npm:@pdf-lib/fontkit@1.1.1";
import { NOTO_SANS_HEBREW_B64 } from "../generate-document-pdf/hebrewFontB64.ts";
import { NOTO_SANS_REGULAR_B64 } from "../generate-document-pdf/notoSansRegularB64.ts";
import { sha256Hex } from "../_shared/signature/types.ts";
import {
  b64ToBytes,
  drawMixedTextCentered,
  drawMixedTextRight,
  fmtDate,
  fmtMoney,
  measureMixedWidth,
} from "../_shared/pdf/hebrewTextLayout.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type FontkitModule = { create: (...args: unknown[]) => unknown };

function resolveFontkit(mod: unknown): FontkitModule {
  if (mod && typeof mod === "object" && "create" in mod && typeof (mod as FontkitModule).create === "function") {
    return mod as FontkitModule;
  }
  const d = (mod as { default?: unknown })?.default;
  if (d && typeof d === "object" && "create" in d && typeof (d as FontkitModule).create === "function") {
    return d as FontkitModule;
  }
  throw new Error("fontkit_unavailable");
}

const fontkit = resolveFontkit(fontkitImport);

const PAYMENT_LABELS: Record<string, string> = {
  cash: "מזומן",
  paybox: "PayBox",
  mom: "אמא",
  bit: "ביט",
  bank_transfer: "העברה בנקאית",
  credit_card: "כרטיס אשראי",
  check: "צ'ק",
  other: "אחר",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type DocRow = {
  document_number: string;
  created_at: string;
  customer_name: string;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
  payment_method: string | null;
  status: string;
};

type BusinessDetails = {
  business_name: string;
  business_id: string;
  address: string;
  phone: string;
  email: string;
};

type SummaryTotals = {
  documentCount: number;
  activeCount: number;
  cancelledCount: number;
  grossTotal: number;
  netTotal: number;
  vatTotal: number;
};

async function renderMonthlySummaryPdf(
  business: BusinessDetails,
  periodStart: string,
  periodEnd: string,
  totals: SummaryTotals,
  paymentBreakdown: Map<string, { count: number; gross: number }>,
  rows: DocRow[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const hebrewFont = await pdfDoc.embedFont(b64ToBytes(NOTO_SANS_HEBREW_B64));
  const bodyFont = await pdfDoc.embedFont(b64ToBytes(NOTO_SANS_REGULAR_B64));

  const pageW = 595;
  const pageH = 842;
  const margin = 50;
  const rightX = pageW - margin;
  const midX = pageW / 2;
  const rowSize = 11;
  const rowStep = rowSize + 9;
  const bottomLimit = margin + 30;

  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;
  let pageNum = 1;

  const drawFooter = () => {
    const footer = `${business.business_name} · עמוד ${pageNum}`;
    drawMixedTextCentered(page, footer, midX, margin - 12, 8, hebrewFont, bodyFont);
  };

  const newPage = () => {
    drawFooter();
    page = pdfDoc.addPage([pageW, pageH]);
    pageNum += 1;
    y = pageH - margin;
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < bottomLimit) newPage();
  };

  const drawFullRow = (label: string, value: string) => {
    drawMixedTextRight(page, label, rightX, y, rowSize, hebrewFont, bodyFont);
    const v = value.trim() || "—";
    const labelW = measureMixedWidth(label, rowSize, hebrewFont, bodyFont);
    drawMixedTextRight(page, v, rightX - labelW - 10, y, rowSize, hebrewFont, bodyFont);
    y -= rowStep;
  };

  const drawSectionTitle = (title: string) => {
    ensureSpace(30);
    drawMixedTextRight(page, title, rightX, y, 16, hebrewFont, bodyFont);
    y -= 20;
    page.drawLine({
      start: { x: margin, y },
      end: { x: rightX, y },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 16;
  };

  // Brand + title
  const brandSize = 26;
  const brand = "SHIRA-FIT";
  const brandW = bodyFont.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, { x: midX - brandW / 2, y: y - brandSize, size: brandSize, font: bodyFont, color: rgb(0.1, 0.1, 0.1) });
  y -= brandSize + 12;
  drawMixedTextCentered(page, "דו״ח ריכוז חודשי", midX, y, 18, hebrewFont, bodyFont);
  y -= 18 + 10;
  drawMixedTextCentered(page, `${fmtDate(periodStart)} – ${fmtDate(periodEnd)}`, midX, y, 12, hebrewFont, bodyFont);
  y -= 12 + 26;

  // Business details
  drawSectionTitle("פרטי העסק");
  drawFullRow("שם העסק:", business.business_name);
  drawFullRow("ע.פ:", business.business_id);
  drawFullRow("כתובת:", business.address || "—");
  drawFullRow("טלפון:", business.phone);
  if (business.email.trim()) drawFullRow("אימייל:", business.email.trim());
  y -= 8;

  // Revenue summary
  drawSectionTitle("סיכום הכנסות");
  drawFullRow("מספר קבלות תקפות:", String(totals.activeCount));
  drawFullRow("סה״כ הכנסות ברוטו:", fmtMoney(totals.grossTotal));
  drawFullRow("סה״כ נטו לפני מע״מ:", fmtMoney(totals.netTotal));
  drawFullRow("סה״כ מע״מ:", fmtMoney(totals.vatTotal));
  if (totals.cancelledCount > 0) {
    drawFullRow("מסמכים שבוטלו ואינם נכללים בסה״כ:", String(totals.cancelledCount));
  }
  y -= 8;

  // Payment method breakdown
  if (paymentBreakdown.size > 0) {
    drawSectionTitle("פירוט לפי אמצעי תשלום");
    for (const [method, agg] of paymentBreakdown) {
      const label = PAYMENT_LABELS[method] ?? method ?? "—";
      drawFullRow(`${label}:`, `${agg.count} x ${fmtMoney(agg.gross)}`);
    }
    y -= 8;
  }

  // Itemized ledger
  drawSectionTitle(`פירוט קבלות: ${rows.length}`);
  if (rows.length === 0) {
    drawMixedTextRight(page, "לא נמצאו קבלות בטווח התאריכים שנבחר.", rightX, y, rowSize, hebrewFont, bodyFont);
    y -= rowStep;
  } else {
    const colDate = rightX;
    const colNumber = rightX - 80;
    const colCustomer = rightX - 190;
    const colPayment = rightX - 330;
    const colAmount = margin + 55;

    const drawHeaderRow = () => {
      const headSize = 9;
      drawMixedTextRight(page, "תאריך", colDate, y, headSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, "מס' קבלה", colNumber, y, headSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, "לקוח", colCustomer, y, headSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, "תשלום", colPayment, y, headSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, "סכום", colAmount, y, headSize, hebrewFont, bodyFont);
      y -= 14;
      page.drawLine({ start: { x: margin, y }, end: { x: rightX, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      y -= 12;
    };

    drawHeaderRow();
    const lineSize = 9.5;
    for (const row of rows) {
      ensureSpace(16);
      if (y === pageH - margin) drawHeaderRow();
      drawMixedTextRight(page, fmtDate(row.created_at), colDate, y, lineSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, row.document_number, colNumber, y, lineSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, row.customer_name, colCustomer, y, lineSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, PAYMENT_LABELS[row.payment_method ?? ""] ?? "—", colPayment, y, lineSize, hebrewFont, bodyFont);
      drawMixedTextRight(page, fmtMoney(row.gross_amount), colAmount, y, lineSize, hebrewFont, bodyFont);
      y -= 15;
    }
  }

  const footer = "מסמך זה הופק באופן ממוחשב לצורך דיווח פנימי לרו״ח.";
  y -= 10;
  ensureSpace(20);
  drawMixedTextCentered(page, footer, midX, y, 8, hebrewFont, bodyFont);

  drawFooter();
  return new Uint8Array(await pdfDoc.save());
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

  let body: { period_start?: string; period_end?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const periodStart = String(body.period_start ?? "").trim();
  const periodEnd = String(body.period_end ?? "").trim();
  if (!periodStart || !periodEnd) return json(400, { ok: false, error: "period_required" });
  const periodStartDate = new Date(periodStart);
  if (Number.isNaN(periodStartDate.getTime()) || Number.isNaN(Date.parse(periodEnd))) {
    return json(400, { ok: false, error: "invalid_period" });
  }
  const periodEndDate = new Date(periodEnd);

  // Monthly summaries must cover exactly one full calendar month — reject custom
  // date ranges or single-day periods, which would otherwise silently masquerade
  // as (and overwrite) a real monthly report.
  const isFirstOfMonth = periodStartDate.getUTCDate() === 1;
  const lastDayOfEndMonth = new Date(
    Date.UTC(periodEndDate.getUTCFullYear(), periodEndDate.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const isLastOfMonth = periodEndDate.getUTCDate() === lastDayOfEndMonth;
  const sameMonth =
    periodStartDate.getUTCFullYear() === periodEndDate.getUTCFullYear() &&
    periodStartDate.getUTCMonth() === periodEndDate.getUTCMonth();
  if (!isFirstOfMonth || !isLastOfMonth || !sameMonth) {
    return json(400, { ok: false, error: "full_calendar_month_required" });
  }

  const periodMonth = `${periodStartDate.getUTCFullYear()}-${String(periodStartDate.getUTCMonth() + 1).padStart(2, "0")}-01`;

  // Replace any prior summary generated for this same calendar month.
  const { data: existing } = await admin
    .from("monthly_summaries")
    .select("id, pdf_url")
    .eq("period_month", periodMonth);
  for (const old of (existing ?? []) as { id: string; pdf_url: string | null }[]) {
    if (old.pdf_url) await admin.storage.from("document-pdfs").remove([old.pdf_url]);
    await admin.from("monthly_summaries").delete().eq("id", old.id);
  }

  const { data: settings, error: settingsErr } = await admin
    .from("receipt_settings")
    .select("business_name, business_id, address, phone, email")
    .limit(1)
    .single();
  if (settingsErr || !settings) return json(500, { ok: false, error: "settings_unavailable" });
  const business = settings as BusinessDetails;

  const { data: docs, error: docsErr } = await admin
    .from("documents")
    .select("document_number, created_at, customer_name, gross_amount, net_amount, vat_amount, payment_method, status")
    .gte("created_at", periodStart)
    .lte("created_at", periodEnd)
    .order("created_at", { ascending: true });
  if (docsErr) return json(500, { ok: false, error: "documents_load_failed" });

  const allRows = (docs ?? []) as DocRow[];
  const activeRows = allRows.filter((r) => r.status === "ACTIVE");
  const cancelledCount = allRows.filter((r) => r.status === "CANCELLED").length;

  const totals: SummaryTotals = {
    documentCount: allRows.length,
    activeCount: activeRows.length,
    cancelledCount,
    grossTotal: activeRows.reduce((s, r) => s + Number(r.gross_amount), 0),
    netTotal: activeRows.reduce((s, r) => s + Number(r.net_amount), 0),
    vatTotal: activeRows.reduce((s, r) => s + Number(r.vat_amount), 0),
  };

  const paymentBreakdown = new Map<string, { count: number; gross: number }>();
  for (const row of activeRows) {
    const key = row.payment_method ?? "other";
    const agg = paymentBreakdown.get(key) ?? { count: 0, gross: 0 };
    agg.count += 1;
    agg.gross += Number(row.gross_amount);
    paymentBreakdown.set(key, agg);
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderMonthlySummaryPdf(business, periodStart, periodEnd, totals, paymentBreakdown, activeRows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("renderMonthlySummaryPdf failed:", msg);
    return json(500, { ok: false, error: msg });
  }

  const hash = await sha256Hex(pdfBytes);
  const storagePath = `summaries/${crypto.randomUUID()}.pdf`;
  const { error: uploadErr } = await admin.storage.from("document-pdfs").upload(storagePath, pdfBytes, {
    contentType: "application/pdf",
    cacheControl: "no-cache, max-age=0",
  });
  if (uploadErr) return json(500, { ok: false, error: uploadErr.message });

  const { data: inserted, error: insertErr } = await admin
    .from("monthly_summaries")
    .insert({
      period_start: periodStart,
      period_end: periodEnd,
      period_month: periodMonth,
      document_count: totals.documentCount,
      active_count: totals.activeCount,
      cancelled_count: totals.cancelledCount,
      gross_total: totals.grossTotal,
      net_total: totals.netTotal,
      vat_total: totals.vatTotal,
      business_name: business.business_name,
      business_id: business.business_id,
      pdf_url: storagePath,
      pdf_hash: hash,
      created_by: callerId,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    await admin.storage.from("document-pdfs").remove([storagePath]);
    return json(500, { ok: false, error: insertErr?.message ?? "insert_failed" });
  }

  return json(200, { ok: true, summary_id: (inserted as { id: string }).id, pdf_path: storagePath });
});
