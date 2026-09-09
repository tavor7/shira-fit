import type { Profile } from "../types/database";

export function isAthleteAccountDisabled(profile: Pick<Profile, "role" | "disabled_at"> | null | undefined): boolean {
  return profile?.role === "athlete" && profile.disabled_at != null && profile.disabled_at !== "";
}

/** True when staff issued a temporary password and this user (any role) must set a new one before using the app. */
export function isPasswordChangeRequired(profile: Pick<Profile, "must_change_password"> | null | undefined): boolean {
  return profile?.must_change_password === true;
}

/**
 * Paused for now: most existing users installed the Home Screen icon before web push
 * existed, so their PWA install is stale and can't receive push even after opting in
 * (confirmed — re-subscribing in-app wasn't enough, only removing and re-adding the icon
 * fixed it). Re-enable once enough users have reinstalled to make the prompt worthwhile.
 */
const NOTIFICATIONS_ONBOARDING_ENABLED = false;

/** True until this account has answered the one-time "enable notifications?" prompt. */
export function isNotificationsOnboardingNeeded(
  profile: Pick<Profile, "notifications_onboarded_at"> | null | undefined
): boolean {
  if (!NOTIFICATIONS_ONBOARDING_ENABLED) return false;
  return profile != null && profile.notifications_onboarded_at == null;
}
