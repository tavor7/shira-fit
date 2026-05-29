import { supabase } from "./supabase";

/**
 * Idempotent server RPC: after the configured studio opening time (Asia/Jerusalem), flips next
 * Sun–Sat non-hidden sessions to open. Safe to call on every screen load; backup when cron is late.
 */
export async function touchWeeklyRegistrationOpenIfDue(): Promise<void> {
  const { error } = await supabase.rpc("open_next_week_sessions_if_due");
  if (error && __DEV__) {
    console.warn("[touchWeeklyRegistrationOpenIfDue]", error.message);
  }
}
