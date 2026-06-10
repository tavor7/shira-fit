/**
 * Generate Hebrew RTL PDF for a document and upload to Storage.
 * POST { document_id, allow_overwrite? }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, degrees, type PDFFont } from "npm:pdf-lib@1.17.1";
import fontkitImport from "npm:@pdf-lib/fontkit@1.1.1";
import { NOTO_SANS_HEBREW_B64 } from "./hebrewFontB64.ts";
import { NOTO_SANS_REGULAR_B64 } from "./notoSansRegularB64.ts";
import { NoOpSignatureProvider, sha256Hex } from "../_shared/signature/types.ts";

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

const SERVICE_LABELS: Record<string, string> = {
  kickboxing: "אימון קיקבוקס",
  personal: "אימון אישי",
  pair: "אימון זוגי",
  trio: "אימון שלישייה",
  quartet: "אימון רביעייה",
  quintet: "אימון חמישייה",
  sextet: "אימון שישייה",
  group_over_6: "אימון קבוצה - מעל 6 משתתפים",
  other: "אימונים",
};

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

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fmtMoney(n: number): string {
  return `₪${Number(n).toFixed(2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type TextRun = { text: string; font: PDFFont };

function fontForChar(ch: string, hebrew: PDFFont, latin: PDFFont): PDFFont {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x0590 && code <= 0x05ff) ||
    (code >= 0xfb1d && code <= 0xfb4f)
  ) {
    return hebrew;
  }
  return latin;
}

function groupRuns(text: string, hebrew: PDFFont, latin: PDFFont): TextRun[] {
  if (!text) return [];
  const runs: TextRun[] = [];
  let buf = text[0]!;
  let font = fontForChar(text[0]!, hebrew, latin);
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    const nextFont = fontForChar(ch, hebrew, latin);
    if (nextFont === font) {
      buf += ch;
    } else {
      runs.push({ text: buf, font });
      buf = ch;
      font = nextFont;
    }
  }
  runs.push({ text: buf, font });
  return runs;
}

function measureMixedWidth(text: string, size: number, hebrew: PDFFont, latin: PDFFont): number {
  return groupRuns(text, hebrew, latin).reduce(
    (w, run) => w + run.font.widthOfTextAtSize(run.text, size),
    0,
  );
}

function isHebrewDominant(text: string): boolean {
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latinChars = (text.match(/[A-Za-z0-9@.]/g) || []).length;
  return hebrewChars > latinChars;
}

function drawMixedTextLeft(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  x: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  let cx = x;
  for (const run of groupRuns(text, hebrew, latin)) {
    page.drawText(run.text, {
      x: cx,
      y: y - size,
      size,
      font: run.font,
      color: rgb(0, 0, 0),
    });
    cx += run.font.widthOfTextAtSize(run.text, size);
  }
}

/** Right-aligned RTL: logical run order, each segment placed right-to-left from the margin. */
function drawMixedTextRight(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  rightX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  const runs = groupRuns(text, hebrew, latin);
  let x = rightX;
  for (const run of runs) {
    const w = run.font.widthOfTextAtSize(run.text, size);
    x -= w;
    page.drawText(run.text, {
      x,
      y: y - size,
      size,
      font: run.font,
      color: rgb(0, 0, 0),
    });
  }
}

/** Width of an RTL token; trailing Latin punctuation sits after the Hebrew word visually. */
function measureRtlTokenWidth(
  token: string,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
): number {
  const match = token.match(/^(.+?)([.!?,:;]+)$/);
  if (match && isHebrewDominant(match[1]!)) {
    return measureMixedWidth(match[1]!, size, hebrew, latin) + latin.widthOfTextAtSize(match[2]!, size);
  }
  return measureMixedWidth(token, size, hebrew, latin);
}

/** Draw one RTL token with its right edge at xRight. */
function drawRtlTokenAt(
  page: ReturnType<PDFDocument["addPage"]>,
  token: string,
  xRight: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
): number {
  const match = token.match(/^(.+?)([.!?,:;]+)$/);
  if (match && isHebrewDominant(match[1]!)) {
    const word = match[1]!;
    const punct = match[2]!;
    const wordW = measureMixedWidth(word, size, hebrew, latin);
    const punctW = latin.widthOfTextAtSize(punct, size);
    xRight -= wordW;
    drawMixedTextLeft(page, word, xRight, y, size, hebrew, latin);
    xRight -= punctW;
    drawMixedTextLeft(page, punct, xRight, y, size, hebrew, latin);
    return wordW + punctW;
  }
  const w = measureMixedWidth(token, size, hebrew, latin);
  xRight -= w;
  drawMixedTextLeft(page, token, xRight, y, size, hebrew, latin);
  return w;
}

/** Centered line with Hebrew words laid out right-to-left. */
function drawRtlLineCentered(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  centerX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  const parts = text.split(/(\s+)/).filter((p) => p.length > 0);
  const widths = parts.map((p) => measureRtlTokenWidth(p, size, hebrew, latin));
  const totalW = widths.reduce((a, b) => a + b, 0);
  let xRight = centerX + totalW / 2;
  for (let i = 0; i < parts.length; i++) {
    xRight -= drawRtlTokenAt(page, parts[i]!, xRight, y, size, hebrew, latin);
  }
}

/** Horizontally centered text (RTL word order for Hebrew-dominant strings). */
function drawMixedTextCentered(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  centerX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  if (isHebrewDominant(text)) {
    drawRtlLineCentered(page, text, centerX, y, size, hebrew, latin);
    return;
  }
  const w = measureMixedWidth(text, size, hebrew, latin);
  drawMixedTextLeft(page, text, centerX - w / 2, y, size, hebrew, latin);
}

/** Branded verification code unique to Shira Fit + this document. */
async function shiraFitVerificationCode(doc: DocRow): Promise<string> {
  const payload = `SHIRA-FIT|${doc.id}|${doc.document_number}|${doc.created_at}|${doc.gross_amount}`;
  return (await sha256Hex(new TextEncoder().encode(payload))).slice(0, 12).toUpperCase();
}

const SHIRA_BRAND = rgb(0.76, 0.36, 0.28);
const SHIRA_INK = rgb(0.12, 0.12, 0.12);

async function drawShiraFitDigitalSeal(
  page: ReturnType<PDFDocument["addPage"]>,
  doc: DocRow,
  centerX: number,
  bottomY: number,
  hebrewFont: PDFFont,
  bodyFont: PDFFont,
): Promise<number> {
  const boxW = 178;
  const boxH = 82;
  const leftX = centerX - boxW / 2;
  const rightX = centerX + boxW / 2;
  const code = await shiraFitVerificationCode(doc);

  page.drawRectangle({
    x: leftX,
    y: bottomY,
    width: boxW,
    height: boxH,
    borderColor: SHIRA_INK,
    borderWidth: 1.6,
    color: rgb(0.99, 0.97, 0.95),
  });
  page.drawRectangle({
    x: leftX + 5,
    y: bottomY + 5,
    width: boxW - 10,
    height: boxH - 10,
    borderColor: SHIRA_BRAND,
    borderWidth: 1,
  });
  page.drawLine({
    start: { x: leftX + 14, y: bottomY + boxH - 28 },
    end: { x: rightX - 14, y: bottomY + boxH - 28 },
    thickness: 0.6,
    color: SHIRA_BRAND,
  });

  const brand = "SHIRA-FIT";
  const brandSize = 13;
  const brandW = bodyFont.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, {
    x: leftX + (boxW - brandW) / 2,
    y: bottomY + boxH - 22,
    size: brandSize,
    font: bodyFont,
    color: SHIRA_INK,
  });

  const signLine = "נחתם דיגיטלית";
  const signSize = 12;
  drawMixedTextCentered(page, signLine, centerX, bottomY + 38, signSize, hebrewFont, bodyFont);

  const meta = `${doc.document_number} · ${code}`;
  const metaSize = 8;
  const metaW = bodyFont.widthOfTextAtSize(meta, metaSize);
  page.drawText(meta, {
    x: leftX + (boxW - metaW) / 2,
    y: bottomY + 12,
    size: metaSize,
    font: bodyFont,
    color: rgb(0.35, 0.35, 0.35),
  });

  return boxH;
}

type DocRow = {
  id: string;
  customer_id: string;
  document_number: string;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
  vat_rate: number;
  payment_method: string | null;
  service_type: string;
  service_description: string | null;
  notes: string | null;
  status: string;
  pdf_url: string | null;
  created_at: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string;
  customer_zip_code: string;
  business_name: string;
  business_id: string;
  business_address: string;
  business_phone: string;
  business_email: string;
};

async function renderHebrewPdf(doc: DocRow): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const hebrewFont = await pdfDoc.embedFont(b64ToBytes(NOTO_SANS_HEBREW_B64));
  const bodyFont = await pdfDoc.embedFont(b64ToBytes(NOTO_SANS_REGULAR_B64));

  const pageW = 595;
  const pageH = 842;
  const margin = 50;
  const rightX = pageW - margin;
  const midX = pageW / 2;
  const colGap = 16;
  const leftColLeft = margin;
  const leftColRight = midX - colGap;
  const rightColLeft = midX + colGap;
  const rightColRight = rightX;
  const rowSize = 11;
  const rowStep = rowSize + 10;
  const page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const drawValue = (value: string, yPos: number, colLeft: number, colRight: number, label: string) => {
    const v = value.trim() || "—";
    const labelW = measureMixedWidth(label, rowSize, hebrewFont, bodyFont);
    const valueAnchor = colRight - labelW - 10;
    if (isHebrewDominant(v)) {
      drawMixedTextRight(page, v, valueAnchor, yPos, rowSize, hebrewFont, bodyFont);
    } else {
      drawMixedTextLeft(page, v, colLeft, yPos, rowSize, hebrewFont, bodyFont);
    }
  };

  const drawColRow = (
    label: string,
    value: string,
    yPos: number,
    colLeft: number,
    colRight: number,
  ) => {
    drawMixedTextRight(page, label, colRight, yPos, rowSize, hebrewFont, bodyFont);
    drawValue(value, yPos, colLeft, colRight, label);
  };

  const drawColSectionTitle = (title: string, align: "left" | "right", yPos: number) => {
    const lineY = yPos - 22;
    if (align === "left") {
      drawMixedTextRight(page, title, leftColRight, yPos, 16, hebrewFont, bodyFont);
      page.drawLine({
        start: { x: leftColLeft, y: lineY },
        end: { x: leftColRight, y: lineY },
        thickness: 0.5,
        color: rgb(0.7, 0.7, 0.7),
      });
    } else {
      drawMixedTextRight(page, title, rightColRight, yPos, 16, hebrewFont, bodyFont);
      page.drawLine({
        start: { x: rightColLeft, y: lineY },
        end: { x: rightColRight, y: lineY },
        thickness: 0.5,
        color: rgb(0.7, 0.7, 0.7),
      });
    }
  };

  const drawFullRow = (label: string, value: string, yPos: number) => {
    drawMixedTextRight(page, label, rightX, yPos, rowSize, hebrewFont, bodyFont);
    drawValue(value, yPos, margin, rightX, label);
  };

  // Brand + title (top center)
  const brandSize = 28;
  const brand = "SHIRA-FIT";
  const brandW = bodyFont.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, {
    x: midX - brandW / 2,
    y: y - brandSize,
    size: brandSize,
    font: bodyFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  y -= brandSize + 12;
  const titleSize = 18;
  drawMixedTextCentered(page, "קבלה / חשבונית מס", midX, y, titleSize, hebrewFont, bodyFont);
  y -= titleSize + 28;

  // Two-column header: document (left) + business (right)
  drawColSectionTitle("פרטי המסמך", "left", y);
  drawColSectionTitle("פרטי העסק", "right", y);
  y -= 28;

  let yLeft = y;
  let yRight = y;

  drawColRow("מספר מסמך:", doc.document_number, yLeft, leftColLeft, leftColRight);
  yLeft -= rowStep;
  drawColRow("תאריך הפקה:", fmtDate(doc.created_at), yLeft, leftColLeft, leftColRight);
  yLeft -= rowStep;
  drawColRow("שעת הפקה:", fmtTime(doc.created_at), yLeft, leftColLeft, leftColRight);
  yLeft -= rowStep;

  drawColRow("שם העסק:", doc.business_name, yRight, rightColLeft, rightColRight);
  yRight -= rowStep;
  drawColRow("ע.פ:", doc.business_id, yRight, rightColLeft, rightColRight);
  yRight -= rowStep;
  drawColRow("כתובת:", doc.business_address || "—", yRight, rightColLeft, rightColRight);
  yRight -= rowStep;
  drawColRow("טלפון:", doc.business_phone, yRight, rightColLeft, rightColRight);
  yRight -= rowStep;
  if (doc.business_email?.trim()) {
    drawColRow("אימייל:", doc.business_email.trim(), yRight, rightColLeft, rightColRight);
    yRight -= rowStep;
  }

  y = Math.min(yLeft, yRight) - 16;

  // Customer section (full width)
  const customerTitleY = y;
  drawMixedTextRight(page, "פרטי לקוח", rightX, customerTitleY, 16, hebrewFont, bodyFont);
  y = customerTitleY - 22;
  page.drawLine({
    start: { x: margin, y },
    end: { x: rightX, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 14;

  drawFullRow("שם לקוח:", doc.customer_name, y);
  y -= rowStep;
  if (doc.customer_address?.trim()) {
    drawFullRow("כתובת:", doc.customer_address.trim(), y);
    y -= rowStep;
  }
  if (doc.customer_zip_code?.trim()) {
    drawFullRow("מיקוד:", doc.customer_zip_code.trim(), y);
    y -= rowStep;
  }
  if (doc.customer_email?.trim()) {
    drawFullRow("אימייל לקוח:", doc.customer_email.trim(), y);
    y -= rowStep;
  }
  drawFullRow("טלפון לקוח:", doc.customer_phone || "—", y);
  y -= rowStep;

  y -= 8;

  // Payment section (full width)
  const paymentTitleY = y;
  drawMixedTextRight(page, "פירוט תשלום", rightX, paymentTitleY, 16, hebrewFont, bodyFont);
  y = paymentTitleY - 22;
  page.drawLine({
    start: { x: margin, y },
    end: { x: rightX, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 14;

  let serviceLabel = SERVICE_LABELS[doc.service_type] ?? doc.service_type;
  if (doc.service_type === "other" && doc.service_description) {
    serviceLabel = `אימונים — ${doc.service_description}`;
  }
  drawFullRow("עבור מה שולם:", serviceLabel, y);
  y -= rowStep;
  drawFullRow("אמצעי תשלום:", PAYMENT_LABELS[doc.payment_method ?? ""] ?? "—", y);
  y -= rowStep;
  drawFullRow("סכום לפני מע״מ:", fmtMoney(doc.net_amount), y);
  y -= rowStep;
  drawFullRow("אחוז מע״מ:", `${Math.round(doc.vat_rate * 10000) / 100}%`, y);
  y -= rowStep;
  drawFullRow("סכום מע״מ:", fmtMoney(doc.vat_amount), y);
  y -= rowStep;
  drawFullRow("סכום כולל ששולם:", fmtMoney(doc.gross_amount), y);
  y -= rowStep;
  drawFullRow("הערות:", doc.notes || "—", y);
  y -= rowStep;

  // Signature block — centered on page; seal above disclaimer at bottom
  const footerSize = 9;
  const footerGap = 12;
  const bottomPad = 32;
  const sealBottom = bottomPad + footerSize + footerGap;

  await drawShiraFitDigitalSeal(page, doc, midX, sealBottom, hebrewFont, bodyFont);

  const footer = "מסמך זה הופק באופן ממוחשב ומהווה העתק נאמן למקור.";
  drawMixedTextCentered(page, footer, midX, bottomPad + footerSize, footerSize, hebrewFont, bodyFont);

  if (doc.status === "CANCELLED") {
    const stamp = "בוטל";
    const stampSize = 48;
    const stampW = hebrewFont.widthOfTextAtSize(stamp, stampSize);
    page.drawText(stamp, {
      x: pageW / 2 - stampW / 2,
      y: pageH / 2,
      size: stampSize,
      font: hebrewFont,
      color: rgb(0.9, 0.22, 0.22),
      rotate: degrees(45),
      opacity: 0.35,
    });
  }

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
  const role = (callerProfile as { role?: string } | null)?.role ?? "";
  if (!["coach", "manager"].includes(role)) return json(403, { ok: false, error: "forbidden" });

  let body: { document_id?: string; allow_overwrite?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const documentId = String(body.document_id ?? "").trim();
  if (!documentId) return json(400, { ok: false, error: "document_id required" });

  const { data: doc, error: docErr } = await admin.from("documents").select("*").eq("id", documentId).single();
  if (docErr || !doc) return json(404, { ok: false, error: "not_found" });

  const row = doc as DocRow;
  if (row.status === "NEEDS_PAYMENT_METHOD") return json(400, { ok: false, error: "needs_payment_method" });

  if (!row.customer_address?.trim() || !row.customer_zip_code?.trim()) {
    try {
      const { data: cust } = await admin
        .from("customers")
        .select("address, zip_code, profile_user_id")
        .eq("id", row.customer_id)
        .maybeSingle();
      const customerRow = cust as { address?: string; zip_code?: string; profile_user_id?: string } | null;
      if (customerRow?.profile_user_id) {
        const { data: prof } = await admin
          .from("profiles")
          .select("address, zip_code")
          .eq("user_id", customerRow.profile_user_id)
          .maybeSingle();
        const profileRow = prof as { address?: string; zip_code?: string } | null;
        if (!row.customer_address?.trim()) {
          row.customer_address = profileRow?.address?.trim() || customerRow.address?.trim() || "";
        }
        if (!row.customer_zip_code?.trim()) {
          row.customer_zip_code = profileRow?.zip_code?.trim() || customerRow.zip_code?.trim() || "";
        }
      }
    } catch (e) {
      console.warn("customer address fallback skipped:", e instanceof Error ? e.message : e);
    }
  }

  if (!row.customer_email?.trim()) {
    try {
      const { data: cust } = await admin
        .from("customers")
        .select("profile_user_id, email")
        .eq("id", row.customer_id)
        .maybeSingle();
      const customerRow = cust as { profile_user_id?: string; email?: string | null } | null;
      if (customerRow?.profile_user_id) {
        const { data: authUser } = await admin.auth.admin.getUserById(customerRow.profile_user_id);
        const authEmail = authUser?.user?.email?.trim() ?? "";
        row.customer_email = authEmail || customerRow.email?.trim() || "";
      }
    } catch (e) {
      console.warn("customer email fallback skipped:", e instanceof Error ? e.message : e);
    }
  }

  const { data: settings } = await admin
    .from("receipt_settings")
    .select("business_name, business_id, address, phone, email, is_operational")
    .limit(1)
    .single();
  const settingsRow = settings as {
    business_name?: string;
    business_id?: string;
    address?: string;
    phone?: string;
    email?: string;
    is_operational?: boolean;
  } | null;
  const isOperational = settingsRow?.is_operational ?? false;
  const allowOverwrite = body.allow_overwrite === true || !isOperational;

  if (allowOverwrite && settingsRow) {
    row.business_name = settingsRow.business_name ?? row.business_name;
    row.business_id = settingsRow.business_id ?? row.business_id;
    row.business_address = settingsRow.address ?? row.business_address;
    row.business_phone = settingsRow.phone ?? row.business_phone;
    row.business_email = settingsRow.email ?? row.business_email;

    if (row.customer_id) {
      try {
        const { data: cust } = await admin
          .from("customers")
          .select("profile_user_id, email")
          .eq("id", row.customer_id)
          .maybeSingle();
        const customerRow = cust as { profile_user_id?: string; email?: string | null } | null;
        if (customerRow?.profile_user_id) {
          const { data: authUser } = await admin.auth.admin.getUserById(customerRow.profile_user_id);
          const authEmail = authUser?.user?.email?.trim() ?? "";
          if (authEmail) row.customer_email = authEmail;
          else if (customerRow.email?.trim()) row.customer_email = customerRow.email.trim();
        }
      } catch (e) {
        console.warn("customer email refresh skipped:", e instanceof Error ? e.message : e);
      }
    }

    await admin
      .from("documents")
      .update({
        business_name: row.business_name,
        business_id: row.business_id,
        business_address: row.business_address,
        business_phone: row.business_phone,
        business_email: row.business_email,
        customer_email: row.customer_email || null,
      })
      .eq("id", row.id);
  }

  if (row.pdf_url && !allowOverwrite) return json(409, { ok: false, error: "pdf_already_exists" });

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderHebrewPdf(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("renderHebrewPdf failed:", msg);
    return json(500, { ok: false, error: msg });
  }

  const signer = new NoOpSignatureProvider();
  const signed = await signer.sign(pdfBytes, { document_id: row.id, document_number: row.document_number });
  pdfBytes = signed.pdfBytes;
  const hash = await sha256Hex(pdfBytes);

  const storagePath = `documents/${row.id}/${row.document_number}.pdf`;
  if (allowOverwrite) {
    await admin.storage.from("document-pdfs").remove([storagePath]);
  }
  const { error: uploadErr } = await admin.storage.from("document-pdfs").upload(storagePath, pdfBytes, {
    contentType: "application/pdf",
    cacheControl: "no-cache, max-age=0",
    upsert: allowOverwrite,
  });
  if (uploadErr) return json(500, { ok: false, error: uploadErr.message });

  const { data: fin, error: finErr } = await admin.rpc("finalize_document_pdf", {
    p_document_id: row.id,
    p_pdf_path: storagePath,
    p_signature_hash: hash,
    p_signature_provider: signed.provider,
    p_allow_overwrite: allowOverwrite,
  });
  if (finErr) return json(500, { ok: false, error: finErr.message });
  const finRow = fin as { ok?: boolean; error?: string };
  if (!finRow?.ok) return json(500, { ok: false, error: finRow.error ?? "finalize_failed" });

  return json(200, { ok: true, pdf_path: storagePath, signature_hash: hash });
});
