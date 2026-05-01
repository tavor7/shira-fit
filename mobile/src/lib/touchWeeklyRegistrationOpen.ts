import { supabase } from "./supabase";

/**
 * Idempotent server RPC: after the configured UTC opening time, flips next Sun–Sat non-hidden
 * sessions to open. Safe to call on every screen load; use as backup when Edge cron is missing/late.
 */
export async function touchWeeklyRegistrationOpenIfDue(): Promise<void> {
  const { error } = await supabase.rpc("open_next_week_sessions_if_due");
  if (error && __DEV__) {
    console.warn("[touchWeeklyRegistrationOpenIfDue]", error.message);
  }
}
