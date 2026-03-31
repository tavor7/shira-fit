/** Muted accents that read well on dark UI. */
export const TRAINER_COLOR_PRESETS = [
  "#5B9BD5",
  "#70AD47",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#4472C4",
  "#E15759",
  "#76D7C4",
  "#AF7AC5",
  "#F4B183",
] as const;

function hashUserId(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Valid stored hex or deterministic fallback from coach user id. */
export function resolveTrainerAccentColor(stored: string | null | undefined, coachUserId: string): string {
  const t = stored?.trim();
  if (t && /^#[0-9A-Fa-f]{6}$/.test(t)) return t;
  const i = hashUserId(coachUserId) % TRAINER_COLOR_PRESETS.length;
  return TRAINER_COLOR_PRESETS[i] ?? "#5B9BD5";
}

export function normalizeHexInput(raw: string): string | null {
  const s = raw.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s.toUpperCase();
  return null;
}
