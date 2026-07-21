/**
 * Email a previously generated monthly summary PDF to the accountant.
 * Requires RESEND_API_KEY.
 * POST { summary_id, recipient_email }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SummaryRow = {
  id: string;
  period_start: string;
  period_end: string;
  business_name: string;
  gross_total: number;
  active_count: number;
  pdf_url: string | null;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Jerusalem" });
}

function summaryEmailHtml(row: SummaryRow): string {
  return `<p dir="rtl">שלום,</p>
<p dir="rtl">מצורף סיכום חודשי לתקופה ${fmtDate(row.period_start)} – ${fmtDate(row.period_end)}, כולל ${row.active_count} קבלות בסך כולל של ₪${Number(row.gross_total).toFixed(2)}.</p>
<p dir="rtl">${row.business_name}</p>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RECEIPT_FROM_EMAIL") ?? "receipts@shira-fit.co.il";

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

  let body: { summary_id?: string; recipient_email?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const summaryId = String(body.summary_id ?? "").trim();
  const recipientEmail = String(body.recipient_email ?? "").trim();
  if (!summaryId || !recipientEmail) return json(400, { ok: false, error: "missing_fields" });

  const { data: summary, error: summaryErr } = await admin
    .from("monthly_summaries")
    .select("id, period_start, period_end, business_name, gross_total, active_count, pdf_url")
    .eq("id", summaryId)
    .maybeSingle();
  if (summaryErr || !summary) return json(404, { ok: false, error: "not_found" });
  const row = summary as SummaryRow;
  if (!row.pdf_url) return json(400, { ok: false, error: "pdf_not_ready" });

  const { data: fileData, error: dlErr } = await admin.storage.from("document-pdfs").download(row.pdf_url);
  if (dlErr || !fileData) return json(500, { ok: false, error: "pdf_download_failed" });
  const pdfBytes = new Uint8Array(await fileData.arrayBuffer());

  let deliveryStatus = "skipped_no_provider";
  if (resendKey) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
        subject: `סיכום חודשי מ-${row.business_name} — ${fmtDate(row.period_start)} עד ${fmtDate(row.period_end)}`,
        html: summaryEmailHtml(row),
        attachments: [{ filename: `monthly-summary-${row.period_start.slice(0, 10)}.pdf`, content: uint8ToBase64(pdfBytes) }],
      }),
    });
    deliveryStatus = resp.ok ? "sent" : `failed_${resp.status}`;
  }

  await admin
    .from("monthly_summaries")
    .update({ sent_at: new Date().toISOString(), sent_to: recipientEmail, delivery_status: deliveryStatus })
    .eq("id", summaryId);

  if (deliveryStatus.startsWith("failed")) return json(500, { ok: false, error: deliveryStatus });
  return json(200, { ok: true, delivery_status: deliveryStatus });
});
