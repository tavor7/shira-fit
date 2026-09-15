import { Platform } from "react-native";
import { supabase } from "./supabase";
import type { RequiredConsent } from "./documents";

export async function fetchCurrentElectronicReceiptsConsentVersion(): Promise<number> {
  const { data, error } = await supabase.rpc("get_current_electronic_receipts_consent_version");
  if (error) throw error;
  const row = data as { ok?: boolean; version?: number } | null;
  return row?.version ?? 1;
}

export async function syncPendingSignupConsent(): Promise<void> {
  const { data, error } = await supabase.rpc("sync_signup_electronic_receipts_consent");
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row?.ok) throw new Error(row?.error ?? "consent_sync_failed");
}

/** Fallback for terms_of_service / privacy_policy / marketing_communications signup
 *  consent when the inline record call at signup had no session yet (email confirmation
 *  pending) — mirrors syncPendingSignupConsent's role for electronic_receipts. */
export async function syncPendingSignupLegalConsents(): Promise<void> {
  const { data, error } = await supabase.rpc("sync_signup_legal_consents");
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row?.ok) throw new Error(row?.error ?? "legal_consent_sync_failed");
}

export async function fetchRequiredConsents(): Promise<RequiredConsent[]> {
  const { data, error } = await supabase.rpc("get_required_consents");
  if (error) throw error;
  const row = data as { ok?: boolean; required?: RequiredConsent[]; error?: string };
  if (!row?.ok) return [];
  return row.required ?? [];
}

export type ConsentType =
  | "electronic_receipts"
  | "terms_of_service"
  | "privacy_policy"
  | "marketing_communications";

export async function recordUserConsent(input: {
  consent_type: ConsentType;
  status: "accepted" | "declined";
  consent_version: number;
}): Promise<void> {
  const userAgent =
    Platform.OS === "web" && typeof navigator !== "undefined" ? navigator.userAgent : Platform.OS;

  const { data, error } = await supabase.rpc("record_user_consent", {
    p_consent_type: input.consent_type,
    p_status: input.status,
    p_consent_version: input.consent_version,
    p_ip_address: null,
    p_user_agent: userAgent,
  });
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string };
  if (!row?.ok) throw new Error(row.error ?? "consent_failed");
}

export type MarketingConsentStatus = {
  available: boolean;
  accepted: boolean;
  version: number;
  title: string;
  body_text: string;
  title_en?: string | null;
  body_text_en?: string | null;
};

/** Marketing consent is always optional and never blocks app use — a separate read/write path from the legal gate. */
export async function fetchMarketingConsentStatus(): Promise<MarketingConsentStatus | null> {
  const { data, error } = await supabase.rpc("get_marketing_consent_status");
  if (error) return null;
  const row = data as { ok?: boolean; available?: boolean } & Partial<MarketingConsentStatus>;
  if (!row?.ok || !row.available) return null;
  return {
    available: true,
    accepted: !!row.accepted,
    version: row.version ?? 1,
    title: row.title ?? "",
    body_text: row.body_text ?? "",
    title_en: row.title_en ?? null,
    body_text_en: row.body_text_en ?? null,
  };
}

export type LegalConsentSettings = {
  gate_enabled: boolean;
  documents: { consent_type: ConsentType; version: number; title: string; title_en: string | null; effective_at: string }[];
};

/** Manager-only: current rollout state + published legal-document versions. */
export async function fetchLegalConsentSettings(): Promise<LegalConsentSettings | null> {
  const { data, error } = await supabase.rpc("get_legal_consent_settings");
  if (error) return null;
  const row = data as { ok?: boolean } & Partial<LegalConsentSettings>;
  if (!row?.ok) return null;
  return { gate_enabled: !!row.gate_enabled, documents: row.documents ?? [] };
}

/** Manager-only: flip the existing-user mandatory legal re-consent gate on/off. */
export async function setLegalConsentGateEnabled(enabled: boolean): Promise<void> {
  const { data, error } = await supabase.rpc("set_legal_consent_gate_enabled", { p_enabled: enabled });
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string };
  if (!row?.ok) throw new Error(row.error ?? "update_failed");
}

export type LegalDocumentVersion = {
  version: number;
  title: string;
  title_en: string | null;
  body_text: string;
  body_text_en: string | null;
  effective_at: string;
  is_current: boolean;
};

/** Manager-only: full version history (title + release date) for one document type. */
export async function fetchLegalDocumentHistory(consentType: ConsentType): Promise<LegalDocumentVersion[]> {
  const { data, error } = await supabase.rpc("get_legal_document_history", { p_consent_type: consentType });
  if (error) return [];
  const row = data as { ok?: boolean; versions?: LegalDocumentVersion[] };
  if (!row?.ok) return [];
  return row.versions ?? [];
}

export type UserLegalConsentStatus = { terms_ok: boolean; privacy_ok: boolean; marketing_ok: boolean };

/** Manager-only: at-a-glance Terms/Privacy/Marketing status for every user, keyed by user_id.
 *  Returns null for non-managers (e.g. coaches) rather than throwing — callers should just
 *  omit the indicator in that case. */
export async function fetchUsersLegalConsentSummary(): Promise<Record<string, UserLegalConsentStatus> | null> {
  const { data, error } = await supabase.rpc("get_users_legal_consent_summary");
  if (error) return null;
  const row = data as { ok?: boolean; users?: (UserLegalConsentStatus & { user_id: string })[] };
  if (!row?.ok || !row.users) return null;
  const map: Record<string, UserLegalConsentStatus> = {};
  for (const u of row.users) {
    map[u.user_id] = { terms_ok: u.terms_ok, privacy_ok: u.privacy_ok, marketing_ok: u.marketing_ok };
  }
  return map;
}
