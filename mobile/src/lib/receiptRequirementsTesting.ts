import { supabase } from "./supabase";

export async function resetOwnReceiptRequirementsForTesting(input?: {
  resetConsent?: boolean;
  resetAddress?: boolean;
}): Promise<void> {
  const { data, error } = await supabase.rpc("manager_reset_own_receipt_requirements_for_testing", {
    p_reset_consent: input?.resetConsent ?? true,
    p_reset_address: input?.resetAddress ?? true,
  });
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row?.ok) throw new Error(row?.error ?? "reset_failed");
}
