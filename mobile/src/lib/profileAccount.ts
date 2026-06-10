import type { Profile } from "../types/database";

export function isAthleteAccountDisabled(profile: Pick<Profile, "role" | "disabled_at"> | null | undefined): boolean {
  return profile?.role === "athlete" && profile.disabled_at != null && profile.disabled_at !== "";
}
