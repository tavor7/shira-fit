/** First token of a person's display name (e.g. for compact calendar labels). */
export function firstWordOfDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}
