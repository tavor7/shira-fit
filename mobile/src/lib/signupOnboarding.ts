import { supabase } from "./supabase";

export async function syncSignupProfileFromMetadata(): Promise<void> {
  const { data, error } = await supabase.rpc("sync_signup_profile_from_metadata");
  if (error) throw error;
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row?.ok) throw new Error(row?.error ?? "signup_profile_sync_failed");
}
