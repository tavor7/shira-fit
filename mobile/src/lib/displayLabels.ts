/**
 * Display labels for stored enum values. The stored value (role, approval status, gender) is what the
 * database and APIs use and is never changed; only what people read is translated. Unknown values fall
 * back to the stored text so nothing disappears.
 */
type T = (key: string) => string;

function labelOrRaw(t: T, key: string, raw: string): string {
  const label = t(key);
  return label === key ? raw : label;
}

export function roleLabel(role: string | null | undefined, t: T): string {
  if (!role) return "";
  return labelOrRaw(t, `roles.${role}`, role);
}

export function approvalStatusLabel(status: string | null | undefined, t: T): string {
  if (!status) return "";
  return labelOrRaw(t, `approvalStatus.${status}`, status);
}

export function genderLabel(gender: string | null | undefined, t: T): string {
  if (!gender) return "";
  return labelOrRaw(t, `profile.${gender}`, gender);
}
