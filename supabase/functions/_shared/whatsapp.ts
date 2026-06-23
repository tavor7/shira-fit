/**
 * Meta WhatsApp Cloud API helpers (server-side only).
 */

export type WhatsAppTemplatePayload = {
  templateName: string;
  languageCode: string;
  bodyParams: string[];
};

export function phoneToWhatsAppRecipient(e164: string): string {
  return e164.replace(/\D/g, "");
}

export function buildTemplateMessage(
  toE164: string,
  tpl: WhatsAppTemplatePayload
): Record<string, unknown> {
  const components =
    tpl.bodyParams.length > 0
      ? [
          {
            type: "body",
            parameters: tpl.bodyParams.map((text) => ({ type: "text", text })),
          },
        ]
      : [];

  return {
    messaging_product: "whatsapp",
    to: phoneToWhatsAppRecipient(toE164),
    type: "template",
    template: {
      name: tpl.templateName,
      language: { code: tpl.languageCode },
      ...(components.length > 0 ? { components } : {}),
    },
  };
}

export function templateFromDelivery(
  notificationType: string,
  payload: Record<string, unknown>
): WhatsAppTemplatePayload {
  const sessionDate = String(payload.session_date ?? "");
  const startTime = String(payload.start_time ?? "");
  const templateOverride = payload.template ? String(payload.template) : notificationType;

  const envWaitlist = Deno.env.get("WHATSAPP_TEMPLATE_WAITLIST") ?? "waitlist_spot";
  const envReminder24 = Deno.env.get("WHATSAPP_TEMPLATE_SESSION_REMINDER") ?? "session_reminder_24h";
  const envReminder3h = Deno.env.get("WHATSAPP_TEMPLATE_SESSION_REMINDER_3H") ?? "session_reminder_3h";
  const envWeeklyOpen = Deno.env.get("WHATSAPP_TEMPLATE_WEEKLY_OPEN") ?? "weekly_registration_open";
  const envHelloWorld = Deno.env.get("WHATSAPP_TEMPLATE_HELLO_WORLD") ?? "hello_world";
  const lang = Deno.env.get("WHATSAPP_DEFAULT_LANGUAGE") ?? "he";
  const helloLang = Deno.env.get("WHATSAPP_TEMPLATE_HELLO_WORLD_LANGUAGE") ?? "en_US";

  if (notificationType === "hello_world" || templateOverride === "hello_world") {
    return {
      templateName: envHelloWorld,
      languageCode: helloLang,
      bodyParams: [],
    };
  }

  if (notificationType === "waitlist_spot") {
    return {
      templateName: templateOverride === "waitlist_spot" ? envWaitlist : templateOverride,
      languageCode: lang,
      bodyParams: [sessionDate, startTime].filter(Boolean),
    };
  }

  if (notificationType === "session_reminder_24h") {
    return {
      templateName: templateOverride === "session_reminder_24h" ? envReminder24 : templateOverride,
      languageCode: lang,
      bodyParams: [sessionDate, startTime].filter(Boolean),
    };
  }

  if (notificationType === "session_reminder_3h") {
    return {
      templateName: templateOverride === "session_reminder_3h" ? envReminder3h : templateOverride,
      languageCode: lang,
      bodyParams: [sessionDate, startTime].filter(Boolean),
    };
  }

  if (notificationType === "weekly_registration_open") {
    const weekLabel = String(payload.week_label ?? payload.week_start ?? "");
    return {
      templateName: templateOverride === "weekly_registration_open" ? envWeeklyOpen : templateOverride,
      languageCode: lang,
      bodyParams: weekLabel ? [weekLabel] : [],
    };
  }

  return {
    templateName: templateOverride,
    languageCode: lang,
    bodyParams: [],
  };
}

export async function sendWhatsAppTemplate(
  toE164: string,
  tpl: WhatsAppTemplatePayload
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  if (!token || !phoneNumberId) {
    return { ok: false, error: "whatsapp_not_configured" };
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const body = buildTemplateMessage(toE164, tpl);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string };
  };

  if (!res.ok) {
    return { ok: false, error: json.error?.message ?? `http_${res.status}` };
  }

  const messageId = json.messages?.[0]?.id ?? "";
  return { ok: true, messageId };
}
