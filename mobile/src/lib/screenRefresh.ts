/**
 * Keep what's on screen while it refreshes (Performance Phase 1 / step 5).
 *
 * Measured before this step (Phase 0 baseline): every return to a home screen, every realtime event on the manager home
 * and every refocus of a session roster replaced already-loaded content with skeletons for ~0.5-1.9 s, unmounting the
 * calendar (week, scroll position and open state reset). Now skeletons show only while nothing usable has been loaded;
 * a background refresh keeps the content, applies only the newest result, and a failed refresh keeps the data.
 */

/** Skeletons only for a first load: once data is on screen, a refresh keeps showing it. */
export function showInitialSkeleton(loading: boolean, hasData: boolean): boolean {
  return loading && !hasData;
}

/**
 * Overlapping loads (focus + realtime bursts + pull-to-refresh) can finish out of order. Each load takes a ticket;
 * only the newest ticket may apply its result, so an older, slower response never overwrites a newer one.
 */
export function createLoadSequencer() {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isLatest(ticket: number): boolean {
      return ticket === latest;
    },
  };
}
