import { supabase } from "./supabase";
import { shareConcurrent } from "./shareConcurrent";

/** Callers in the same JS task (the gates on mount / resume) share one request; see shareConcurrent. */
export const fetchAddressCollectionRequired = shareConcurrent(fetchAddressCollectionRequiredOnce);

async function fetchAddressCollectionRequiredOnce(): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_address_collection_required");
  if (error) throw error;
  const row = data as { ok?: boolean; required?: boolean };
  if (!row?.ok) return false;
  return row.required === true;
}
