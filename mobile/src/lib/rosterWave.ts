import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";
import { fetchSessionRegistrationsWithProfiles } from "./sessionRosterQueries";

/**
 * The session roster's first request wave (ParticipantAttendanceList): session row, roster price overrides, registrations
 * with profiles, walk-ins, receipt locks and subscription coverage, all independent of each other.
 */
export function fetchRosterWave1(sessionId: string) {
  const fetchManual = async () => {
    let res = await supabase
      .from("session_manual_participants")
      .select("manual_participant_id, attended, charge_no_show, payment_method, amount_paid, manual_participants(full_name, phone, date_of_birth)")
      .eq("session_id", sessionId);
    if (res.error && isMissingColumnError(res.error.message, "date_of_birth")) {
      res = (await supabase
        .from("session_manual_participants")
        .select("manual_participant_id, attended, charge_no_show, payment_method, amount_paid, manual_participants(full_name, phone)")
        .eq("session_id", sessionId)) as typeof res;
    }
    return res;
  };
  return Promise.all([
    supabase
      .from("training_sessions")
      .select("max_participants, session_date, start_time, coach_id, is_kickbox, custom_slot_price_ils")
      .eq("id", sessionId)
      .single(),
    supabase.from("session_roster_slot_prices").select("user_id, manual_participant_id, price_ils").eq("session_id", sessionId),
    fetchSessionRegistrationsWithProfiles(sessionId),
    fetchManual(),
    supabase.rpc("session_payment_receipt_locks", { p_session_id: sessionId }),
    supabase.rpc("session_subscription_coverage", { p_session_id: sessionId }),
  ]);
}

type Wave1 = ReturnType<typeof fetchRosterWave1>;

/** A prefetch is used only by the next roster load of the same session, and only if it started this recently. */
const PREFETCH_MAX_AGE_MS = 4_000;
let prefetched: { sessionId: string; startedAt: number; promise: Wave1 } | null = null;

/**
 * Performance Phase 5: manager Session Detail renders its roster only after its own session row has loaded, so the
 * roster's requests used to start one round trip late. The screen now starts this wave when it opens, in parallel with
 * its own load; the roster's first load picks it up. Single use; anything older, for another session, or a later load
 * (refresh, realtime, focus) fetches fresh.
 */
export function prefetchRosterWave1(sessionId: string): void {
  prefetched = { sessionId, startedAt: Date.now(), promise: fetchRosterWave1(sessionId) };
  // A prefetch nobody picks up must not surface as an unhandled rejection.
  prefetched.promise.catch(() => undefined);
}

export function takeRosterWave1(sessionId: string, now = Date.now()): Wave1 {
  const p = prefetched;
  prefetched = null;
  if (p && p.sessionId === sessionId && now - p.startedAt <= PREFETCH_MAX_AGE_MS) return p.promise;
  return fetchRosterWave1(sessionId);
}
