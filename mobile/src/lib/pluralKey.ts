/**
 * Picks the singular form of a count template when n is 1: looks up `<key>_one` (e.g. "{n} session")
 * and falls back to `<key>` (e.g. "{n} sessions"). Both languages define `_one` where the noun changes
 * ("1 participants" → "1 participant", "אימונים 1" → "אימון אחד"). Callers still substitute {n} themselves.
 */
export function pluralKey(t: (key: string) => string, key: string, n: number): string {
  if (n === 1) {
    const one = t(`${key}_one`);
    if (one !== `${key}_one`) return one;
  }
  return t(key);
}
