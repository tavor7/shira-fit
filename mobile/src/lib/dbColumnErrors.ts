/** True when PostgREST reports a column missing (migration not applied or stale schema cache). */
export function isMissingColumnError(message: string | undefined, column: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const c = column.toLowerCase();
  if (!m.includes(c)) return false;
  return m.includes("schema cache") || m.includes("could not find") || m.includes("column");
}
