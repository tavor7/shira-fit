/**
 * Per-manager operational notification preferences: whether THIS manager wants a push when (A) a
 * group session goes from full to not-full, or (B) a participant is removed from a non-group
 * session. Thin wrapper around get_manager_notification_prefs()/set_manager_notification_prefs()
 * (see 20260930100000_manager_operational_notifications.sql) -- the backend, not this module, is
 * authoritative for defaults and access control; this only shapes RPC input/output for the UI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ManagerOperationalNotificationPrefs = {
  notifyGroupSpotAvailable: boolean;
  notifyNongroupRemoval: boolean;
};

/** Matches the backend's column defaults (both true) -- used only as a transient UI fallback
 * before the RPC resolves; never written back without an explicit round-trip to the server. */
export const DEFAULT_MANAGER_OPERATIONAL_NOTIFICATION_PREFS: ManagerOperationalNotificationPrefs = {
  notifyGroupSpotAvailable: true,
  notifyNongroupRemoval: true,
};

export type ManagerOperationalNotificationPrefsError = { ok: false; error: string };

/** Parses the raw {ok, notify_group_spot_available, notify_nongroup_removal} RPC payload. Returns
 * null for a malformed/failed response so the caller can fall back to defaults explicitly rather
 * than silently coercing `undefined` to a boolean. */
export function parseManagerOperationalNotificationPrefs(data: unknown): ManagerOperationalNotificationPrefs | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.ok !== true) return null;
  if (typeof rec.notify_group_spot_available !== "boolean" || typeof rec.notify_nongroup_removal !== "boolean") {
    return null;
  }
  return {
    notifyGroupSpotAvailable: rec.notify_group_spot_available,
    notifyNongroupRemoval: rec.notify_nongroup_removal,
  };
}

export async function rpcGetManagerOperationalNotificationPrefs(
  supabase: SupabaseClient
): Promise<ManagerOperationalNotificationPrefs | ManagerOperationalNotificationPrefsError> {
  const { data, error } = await supabase.rpc("get_manager_notification_prefs");
  if (error) throw error;
  const parsed = parseManagerOperationalNotificationPrefs(data);
  if (parsed) return parsed;
  const rec = data as Record<string, unknown> | null;
  return { ok: false, error: typeof rec?.error === "string" ? rec.error : "invalid_response" };
}

export async function rpcSetManagerOperationalNotificationPrefs(
  supabase: SupabaseClient,
  prefs: ManagerOperationalNotificationPrefs
): Promise<ManagerOperationalNotificationPrefs | ManagerOperationalNotificationPrefsError> {
  const { data, error } = await supabase.rpc("set_manager_notification_prefs", {
    p_notify_group_spot_available: prefs.notifyGroupSpotAvailable,
    p_notify_nongroup_removal: prefs.notifyNongroupRemoval,
  });
  if (error) throw error;
  const parsed = parseManagerOperationalNotificationPrefs(data);
  if (parsed) return parsed;
  const rec = data as Record<string, unknown> | null;
  return { ok: false, error: typeof rec?.error === "string" ? rec.error : "invalid_response" };
}
