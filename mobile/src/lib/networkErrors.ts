/** Heuristic for Supabase/fetch failures when the device is offline or the network is flaky. */
export function isLikelyNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /network|fetch failed|failed to fetch|offline|ECONNREFUSED|ETIMEDOUT|timeout|internet|connect/i.test(
    msg
  );
}

/** Appends a localized offline hint when the failure looks network-related. */
export function appendNetworkHint(err: unknown, hint: string): string {
  const base = err instanceof Error ? err.message : String(err);
  return isLikelyNetworkError(err) ? `${base}\n\n${hint}` : base;
}
