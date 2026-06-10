/**
 * Send document PDF by email. Requires RESEND_API_KEY.
 * POST { document_id, recipient_email }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

  let body: { document_id?: string; recipient_email?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const documentId = String(body.document_id ?? "").trim();
  const recipientEmail = String(body.recipient_email ?? "").trim();
  if (!documentId || !recipientEmail) return json(400, { ok: false, error: "missing_fields" });

  const { data: doc, error: docErr } = await admin
    .from("documents")
    .select("id, document_number, pdf_url, business_name, customer_name")
    .eq("id", documentId)
    .single();
  if (docErr || !doc) return json(404, { ok: false, error: "not_found" });

  const row = doc as {
    id: string;
    document_number: string;
    pdf_url: string | null;
    business_name: string;
    customer_name: string;
  };
  if (!row.pdf_url) return json(400, { ok: false, error: "pdf_not_ready" });

  const { data: fileData, error: dlErr } = await admin.storage.from("document-pdfs").download(row.pdf_url);
  if (dlErr || !fileData) return json(500, { ok: false, error: "pdf_download_failed" });

  const pdfBytes = new Uint8Array(await fileData.arrayBuffer());
  const pdfBase64 = btoa(String.fromCharCode(...pdfBytes));

  let deliveryStatus = "skipped_no_provider";
  if (resendKey) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
        subject: `קבלה מ-${row.business_name} — ${row.document_number}`,
        html: `<p dir="rtl">שלום ${row.customer_name},</p><p dir="rtl">מצורפת קבלה עבור התשלום שבוצע.</p><p dir="rtl">תודה,<br/>${row.business_name}</p>`,
        attachments: [{ filename: `${row.document_number}.pdf`, content: pdfBase64 }],
      }),
    });
    deliveryStatus = resp.ok ? "sent" : `failed_${resp.status}`;
  }

  await admin.rpc("record_document_email_sent", {
    p_document_id: row.id,
    p_recipient_email: recipientEmail,
    p_delivery_status: deliveryStatus,
  });

  if (deliveryStatus.startsWith("failed")) {
    return json(500, { ok: false, error: deliveryStatus });
  }

  return json(200, { ok: true, delivery_status: deliveryStatus });
});
