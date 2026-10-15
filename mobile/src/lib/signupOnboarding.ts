import { supabase } from "./supabase";

/** Fills empty profile fields from signup metadata (idempotent). Resolves to whether the profile row was written. */
export async function syncSignupProfileFromMetadata(): Promise<boolean> {
  const { data, error } = await supabase.rpc("sync_signup_profile_from_metadata");
  if (error) throw error;
  const row = data as { ok?: boolean; applied?: boolean; error?: string } | null;
  if (!row?.ok) throw new Error(row?.error ?? "signup_profile_sync_failed");
  return row.applied === true;
}
