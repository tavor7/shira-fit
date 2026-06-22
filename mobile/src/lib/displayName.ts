/** First token of a person's display name (e.g. for compact calendar labels). */
export function firstWordOfDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** Compact label for athlete picker fields (name · phone). */
export function athletePickerLabel(name: string, phone?: string | null): string {
  const n = name.trim();
  const p = (phone ?? "").trim();
  return p ? `${n} · ${p}` : n || "—";
}

/** Subtitle line under an athlete name in search results. */
export function athleteSearchSubtitle(phone?: string | null): string {
  const p = (phone ?? "").trim();
  return p || "—";
}
