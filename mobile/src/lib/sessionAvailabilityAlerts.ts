import { supabase } from "./supabase";

/** Same line as the server's subscription_tier_for_capacity: "group" means capacity 7 or more. */
export const AVAILABILITY_MIN_CAPACITY = 7;

export type AvailabilityAlertState = { enabled: boolean; subscribed: boolean };

type OfferInput = AvailabilityAlertState & {
  maxParticipants: number;
  full: boolean;
  registered: boolean;
  registrationOpen: boolean;
  sessionNotStarted: boolean;
};

/** Which action, if any, the session screen offers. Someone already subscribed can always stop, whatever else changed. */
export function availabilityAlertAction(input: OfferInput): "subscribe" | "unsubscribe" | null {
  if (input.registered) return null;
  if (input.subscribed) return "unsubscribe";
  if (!input.enabled || !input.sessionNotStarted || !input.registrationOpen) return null;
  if (!input.full || input.maxParticipants < AVAILABILITY_MIN_CAPACITY) return null;
  return "subscribe";
}

function parseRow(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

/** Null when the state could not be read: the screen then offers nothing rather than guessing. */
export async function fetchAvailabilityAlertState(sessionId: string): Promise<AvailabilityAlertState | null> {
  const { data, error } = await supabase.rpc("session_availability_state", { p_session_id: sessionId });
  if (error) return null;
  const o = parseRow(data);
  if (!o || o.ok !== true) return null;
  return { enabled: o.enabled === true, subscribed: o.subscribed === true };
}

export async function setAvailabilityAlert(
  sessionId: string,
  subscribe: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc(
    subscribe ? "subscribe_session_availability" : "unsubscribe_session_availability",
    { p_session_id: sessionId }
  );
  if (error) return { ok: false, error: error.message };
  const o = parseRow(data);
  if (!o || o.ok !== true) return { ok: false, error: String(o?.error ?? "unknown") };
  return { ok: true };
}

/** Session ids for the Home alert. Empty while the feature is off, and when the lookup fails: an alert is a bonus here. */
export async function fetchMyAvailabilitySubscriptions(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_session_availability_subscriptions");
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map(String);
}
