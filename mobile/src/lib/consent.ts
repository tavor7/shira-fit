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

export async function fetchRequiredConsents(): Promise<RequiredConsent[]> {
  const { data, error } = await supabase.rpc("get_required_consents");
  if (error) throw error;
  const row = data as { ok?: boolean; required?: RequiredConsent[]; error?: string };
  if (!row?.ok) return [];
  return row.required ?? [];
}

export async function recordUserConsent(input: {
  consent_type: "electronic_receipts" | "terms_of_service" | "privacy_policy";
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
