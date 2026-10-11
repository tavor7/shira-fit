/** What the connection bar shows (Phase 5 / O + T); null = nothing. */
export type OfflineNoticePhase = "offline" | "reconnecting" | "backOnline" | null;

/**
 * Next phase when connectivity or the "page still loading" signal changes. Timers (how long
 * "Back online" stays, the cap on "Reconnecting…") are applied by the component.
 */
export function nextOfflineNoticePhase(
  prev: OfflineNoticePhase,
  { offline, loading }: { offline: boolean; loading: boolean }
): OfflineNoticePhase {
  if (offline) return "offline";
  if (prev === "offline") return loading ? "reconnecting" : "backOnline";
  if (prev === "reconnecting" && !loading) return "backOnline";
  return prev;
}
