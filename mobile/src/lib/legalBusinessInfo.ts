import { supabase } from "./supabase";

export type PublicBusinessInfo = {
  businessName: string;
  businessId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  vatEnabled: boolean;
};

const FALLBACK: PublicBusinessInfo = {
  businessName: "Shira Fit",
  businessId: null,
  address: null,
  phone: "052-959-3297",
  email: "shira5252@gmail.com",
  vatEnabled: false,
};

/** Public, unauthenticated-safe business identity for the legal pages (not the full staff-only receipt_settings). */
export async function fetchPublicBusinessInfo(): Promise<PublicBusinessInfo> {
  try {
    const { data, error } = await supabase.rpc("get_public_business_info");
    if (error || !data) return FALLBACK;
    const row = data as Record<string, unknown>;
    if (row.ok !== true) return FALLBACK;
    return {
      businessName: (row.business_name as string | null) ?? FALLBACK.businessName,
      businessId: (row.business_id as string | null) ?? null,
      address: (row.address as string | null) ?? FALLBACK.address,
      phone: (row.phone as string | null) ?? FALLBACK.phone,
      email: (row.email as string | null) ?? FALLBACK.email,
      vatEnabled: (row.vat_enabled as boolean | null) ?? false,
    };
  } catch {
    return FALLBACK;
  }
}

/** Substitutes {{TOKEN}} placeholders in legal document text with live business identity. */
export function fillLegalTokens(text: string, info: PublicBusinessInfo, language: "en" | "he"): string {
  const dealerStatus = info.vatEnabled
    ? language === "he"
      ? "עוסק מורשה"
      : "a licensed dealer (עוסק מורשה)"
    : language === "he"
      ? "עוסק פטור"
      : "an exempt dealer (עוסק פטור)";

  // A full clause (not a bare token) so a missing business_id omits cleanly — no dangling
  // "(Business ID: )" — rather than needing every call site to special-case it.
  const businessIdClause = info.businessId
    ? language === "he"
      ? ` (מס' עוסק: ${info.businessId})`
      : ` (Business ID: ${info.businessId})`
    : "";

  return text
    .replaceAll("{{BUSINESS_NAME}}", info.businessName)
    .replaceAll("{{DEALER_STATUS}}", dealerStatus)
    .replaceAll("{{BUSINESS_ID_CLAUSE}}", businessIdClause)
    .replaceAll("{{BUSINESS_ADDRESS}}", info.address ?? (language === "he" ? "ישראל" : "Israel"))
    .replaceAll("{{BUSINESS_PHONE}}", info.phone ?? "")
    .replaceAll("{{BUSINESS_EMAIL}}", info.email ?? "")
    .replaceAll("{{BUSINESS_ID}}", info.businessId ?? "");
}
