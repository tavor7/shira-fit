/**
 * Send document PDF(s) by email. Requires RESEND_API_KEY.
 *
 * Single:  POST { document_id, recipient_email }
 * Accountant batch: POST { document_ids, recipient_email }
 * Customer batch:   POST { document_ids, mode: "customers" }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DocRow = {
  id: string;
  document_number: string;
  pdf_url: string | null;
  business_name: string;
  customer_name: string;
  customer_email: string | null;
};

type Attachment = { filename: string; content: string };

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

async function loadDocuments(admin: ReturnType<typeof createClient>, ids: string[]): Promise<DocRow[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const { data, error } = await admin
    .from("documents")
    .select("id, document_number, pdf_url, business_name, customer_name, customer_email")
    .in("id", unique);
  if (error) throw new Error("documents_load_failed");

  const byId = new Map((data as DocRow[]).map((d) => [d.id, d]));
  return unique.map((id) => byId.get(id)).filter((d): d is DocRow => !!d);
}

async function buildAttachments(
  admin: ReturnType<typeof createClient>,
  docs: DocRow[]
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const doc of docs) {
    if (!doc.pdf_url) continue;
    const { data: fileData, error: dlErr } = await admin.storage.from("document-pdfs").download(doc.pdf_url);
    if (dlErr || !fileData) throw new Error("pdf_download_failed");
    const pdfBytes = new Uint8Array(await fileData.arrayBuffer());
    attachments.push({
      filename: `${doc.document_number}.pdf`,
      content: uint8ToBase64(pdfBytes),
    });
  }
  return attachments;
}

async function sendResendEmail(
  resendKey: string,
  fromEmail: string,
  to: string,
  subject: string,
  html: string,
  attachments: Attachment[]
): Promise<string> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html, attachments }),
  });
  return resp.ok ? "sent" : `failed_${resp.status}`;
}

async function recordSent(
  admin: ReturnType<typeof createClient>,
  docs: DocRow[],
  recipientEmail: string,
  deliveryStatus: string
) {
  for (const doc of docs) {
    await admin.rpc("record_document_email_sent", {
      p_document_id: doc.id,
      p_recipient_email: recipientEmail,
      p_delivery_status: deliveryStatus,
    });
  }
}

function customerEmailHtml(businessName: string, customerName: string, docs: DocRow[]): string {
  const list = docs.map((d) => `<li dir="rtl">${d.document_number}</li>`).join("");
  const intro =
    docs.length === 1
      ? "<p dir=\"rtl\">מצורפת קבלה עבור התשלום שבוצע.</p>"
      : `<p dir="rtl">מצורפות ${docs.length} קבלות עבור התשלומים שבוצעו:</p><ul>${list}</ul>`;
  return `<p dir="rtl">שלום ${customerName},</p>${intro}<p dir="rtl">תודה,<br/>${businessName}</p>`;
}

function accountantEmailHtml(businessName: string, docs: DocRow[]): string {
  const list = docs.map((d) => `<li dir="rtl">${d.document_number} — ${d.customer_name}</li>`).join("");
  return `<p dir="rtl">שלום,</p><p dir="rtl">מצורפות ${docs.length} קבלות:</p><ul>${list}</ul><p dir="rtl">${businessName}</p>`;
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

  let body: {
    document_id?: string;
    document_ids?: string[];
    recipient_email?: string;
    mode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  const documentIds = Array.isArray(body.document_ids)
    ? body.document_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const singleId = String(body.document_id ?? "").trim();
  const recipientEmail = String(body.recipient_email ?? "").trim();
  const mode = String(body.mode ?? "").trim();

  try {
    // —— Single document (legacy) ——
    if (singleId && recipientEmail && documentIds.length === 0) {
      const docs = await loadDocuments(admin, [singleId]);
      const row = docs[0];
      if (!row) return json(404, { ok: false, error: "not_found" });
      if (!row.pdf_url) return json(400, { ok: false, error: "pdf_not_ready" });

      const attachments = await buildAttachments(admin, [row]);
      let deliveryStatus = "skipped_no_provider";
      if (resendKey) {
        deliveryStatus = await sendResendEmail(
          resendKey,
          fromEmail,
          recipientEmail,
          `קבלה מ-${row.business_name} — ${row.document_number}`,
          customerEmailHtml(row.business_name, row.customer_name, [row]),
          attachments
        );
      }
      await recordSent(admin, [row], recipientEmail, deliveryStatus);
      if (deliveryStatus.startsWith("failed")) return json(500, { ok: false, error: deliveryStatus });
      return json(200, { ok: true, delivery_status: deliveryStatus, emails_sent: 1, documents_sent: 1 });
    }

    // —— Batch modes ——
    if (documentIds.length === 0) return json(400, { ok: false, error: "missing_fields" });

    const allDocs = await loadDocuments(admin, documentIds);
    const withPdf = allDocs.filter((d) => d.pdf_url);
    if (withPdf.length === 0) return json(400, { ok: false, error: "pdf_not_ready" });

    const businessName = withPdf[0].business_name;

    // Per-customer: one email per unique customer_email
    if (mode === "customers") {
      const groups = new Map<string, DocRow[]>();
      let skippedNoEmail = 0;
      for (const doc of withPdf) {
        const email = doc.customer_email?.trim().toLowerCase();
        if (!email) {
          skippedNoEmail += 1;
          continue;
        }
        const list = groups.get(email) ?? [];
        list.push(doc);
        groups.set(email, list);
      }

      if (groups.size === 0) {
        return json(400, { ok: false, error: "no_customer_emails", skipped_no_email: skippedNoEmail });
      }

      let emailsSent = 0;
      let documentsSent = 0;
      const failures: string[] = [];

      for (const [email, docs] of groups) {
        const attachments = await buildAttachments(admin, docs);
        if (attachments.length === 0) continue;

        const customerName = docs[0].customer_name;
        const subject =
          docs.length === 1
            ? `קבלה מ-${businessName} — ${docs[0].document_number}`
            : `קבלות מ-${businessName} — ${docs.length} מסמכים`;

        let deliveryStatus = "skipped_no_provider";
        if (resendKey) {
          deliveryStatus = await sendResendEmail(
            resendKey,
            fromEmail,
            email,
            subject,
            customerEmailHtml(businessName, customerName, docs),
            attachments
          );
        }

        await recordSent(admin, docs, email, deliveryStatus);
        if (deliveryStatus.startsWith("failed")) {
          failures.push(email);
        } else {
          emailsSent += 1;
          documentsSent += docs.length;
        }
      }

      if (failures.length > 0 && emailsSent === 0) {
        return json(500, { ok: false, error: "send_failed", failed_recipients: failures });
      }

      return json(200, {
        ok: true,
        emails_sent: emailsSent,
        documents_sent: documentsSent,
        skipped_no_email: skippedNoEmail,
        failed_recipients: failures,
      });
    }

    // Accountant / explicit recipient: one email with all PDFs
    if (!recipientEmail) return json(400, { ok: false, error: "missing_recipient" });

    const attachments = await buildAttachments(admin, withPdf);
    const subject =
      withPdf.length === 1
        ? `קבלה מ-${businessName} — ${withPdf[0].document_number}`
        : `קבלות מ-${businessName} — ${withPdf.length} מסמכים`;

    let deliveryStatus = "skipped_no_provider";
    if (resendKey) {
      deliveryStatus = await sendResendEmail(
        resendKey,
        fromEmail,
        recipientEmail,
        subject,
        accountantEmailHtml(businessName, withPdf),
        attachments
      );
    }

    await recordSent(admin, withPdf, recipientEmail, deliveryStatus);
    if (deliveryStatus.startsWith("failed")) return json(500, { ok: false, error: deliveryStatus });

    return json(200, {
      ok: true,
      delivery_status: deliveryStatus,
      emails_sent: 1,
      documents_sent: withPdf.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "send_failed";
    return json(500, { ok: false, error: msg });
  }
});
