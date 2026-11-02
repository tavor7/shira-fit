import { syncExpoPushTokenIfNeeded } from "./pushTokenSync";
import { syncWebPushSubscriptionIfNeeded } from "./webPushSync";

/**
 * When the push registration was last re-synced in this app session (Performance Phase 3).
 *
 * The (app) layout syncs once per login for every role, and the settings toggles / activation flows sync directly
 * whenever notification preferences or permission change. The athlete home additionally re-synced on every focus
 * (two Auth-server getUser calls each time) as a safety net for a subscription the browser silently replaced; that
 * safety net now runs at most every RESYNC_MS. Freshness rule: a login, a preference or permission change always syncs
 * immediately; otherwise an athlete's push registration is re-checked at most every RESYNC_MS while the app is used.
 */
const RESYNC_MS = 10 * 60_000;
let lastSyncAt = 0;

/** Login / preference / permission sync: always runs, and counts as the latest re-sync. */
export function syncPushRegistrationNow(): void {
  lastSyncAt = Date.now();
  void syncExpoPushTokenIfNeeded();
  void syncWebPushSubscriptionIfNeeded();
}

/** Periodic safety-net re-sync (athlete home focus): only when the last one is RESYNC_MS old. */
export function syncPushRegistrationIfStale(now = Date.now()): boolean {
  if (now - lastSyncAt < RESYNC_MS) return false;
  syncPushRegistrationNow();
  return true;
}

/** Tests only. */
export function __resetPushSyncScheduleForTests(): void {
  lastSyncAt = 0;
}
