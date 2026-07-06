import { supabase } from "./supabase";

export async function fetchAddressCollectionRequired(): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_address_collection_required");
  if (error) throw error;
  const row = data as { ok?: boolean; required?: boolean };
  if (!row?.ok) return false;
  return row.required === true;
}
