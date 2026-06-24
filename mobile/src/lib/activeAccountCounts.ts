import { supabase } from "./supabase";

export type ActiveAccountCounts = {
  appAthletes: number;
  quickAddOnly: number;
  total: number;
};

/** App athlete profiles (not deactivated) + quick-add rows without a linked app account. */
export async function fetchActiveAccountCounts(): Promise<ActiveAccountCounts | null> {
  const [appRes, quickRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "athlete")
      .is("disabled_at", null),
    supabase
      .from("manual_participants")
      .select("id", { count: "exact", head: true })
      .is("linked_user_id", null),
  ]);

  if (appRes.error || quickRes.error) return null;

  const appAthletes = appRes.count ?? 0;
  const quickAddOnly = quickRes.count ?? 0;
  return { appAthletes, quickAddOnly, total: appAthletes + quickAddOnly };
}
