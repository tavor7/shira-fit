/**
 * What an `onAuthStateChange` event should trigger in AuthContext (Performance Phase 1 / step 2).
 *
 * Measured before this change (Phase 0 baseline): supabase-js fires INITIAL_SESSION right after the app subscribes and
 * SIGNED_IN on every return to a visible tab / Home Screen app; each one re-ran the whole profile chain (profile + three
 * signup syncs + profile again) and replaced the session object, re-rendering the entire app.
 */

/** Same-user SIGNED_IN (tab / PWA resume) refreshes the profile at most this often. */
export const RESUME_PROFILE_REFRESH_MIN_MS = 30_000;

export type AuthEventAction =
  | { kind: "signedOut" }
  /** A different user (or the first user) is now signed in: full profile load; block the UI only for real sign-ins. */
  | { kind: "userChanged"; blockUi: boolean }
  /**
   * Same user: keep the existing profile. `updateSession` only when the access token changed (avoids re-rendering the
   * app for identical sessions). `refreshProfile` keeps approval / disabled / role changes fresh on resume.
   */
  | { kind: "sameUser"; updateSession: boolean; refreshProfile: boolean };

export function decideAuthEventAction(input: {
  event: string;
  prevUserId: string | null;
  nextUserId: string | null;
  prevAccessToken: string | null;
  nextAccessToken: string | null;
  msSinceProfileLoad: number;
}): AuthEventAction {
  const { event, prevUserId, nextUserId } = input;
  if (!nextUserId) return { kind: "signedOut" };
  if (prevUserId !== nextUserId) {
    // Background events never swap the app for a full-screen spinner (see AuthContext doc comment).
    const background = event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED";
    return { kind: "userChanged", blockUi: !background };
  }
  const updateSession = input.prevAccessToken !== input.nextAccessToken;
  const refreshProfile =
    event === "USER_UPDATED" || (event === "SIGNED_IN" && input.msSinceProfileLoad >= RESUME_PROFILE_REFRESH_MIN_MS);
  return { kind: "sameUser", updateSession, refreshProfile };
}
