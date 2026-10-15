import { supabase } from "./supabase";

/**
 * The signed-in user's id from the locally stored session - no network round trip, unlike `supabase.auth.getUser()`
 * (which asks the Auth server every time; 527 calls/day at p50 216 ms in production, up to 9 per athlete home load).
 * `getSession()` refreshes an expired access token first, so the id always belongs to the token the next request sends.
 *
 * Use ONLY where the server stays authoritative: filtering the user's own rows (RLS restricts reads to what the user
 * may see), deciding what the UI shows, or calling RPCs that derive the caller from `auth.uid()`. Never pass it to the
 * server as proof of identity. Push-subscription syncs (once per login) deliberately keep the server-validated
 * `getUser()`.
 */
export async function getCurrentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}
