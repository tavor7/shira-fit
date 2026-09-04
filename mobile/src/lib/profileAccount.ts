import type { Profile } from "../types/database";

export function isAthleteAccountDisabled(profile: Pick<Profile, "role" | "disabled_at"> | null | undefined): boolean {
  return profile?.role === "athlete" && profile.disabled_at != null && profile.disabled_at !== "";
}

/** True when staff issued a temporary password and this user (any role) must set a new one before using the app. */
export function isPasswordChangeRequired(profile: Pick<Profile, "must_change_password"> | null | undefined): boolean {
  return profile?.must_change_password === true;
}
