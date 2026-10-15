/**
 * Pure analysis of recorded performance data (docs/performance/README.md defines every metric).
 * All times are milliseconds on the page's `performance.now()` clock.
 */

export type PerfRequestRecord = {
  id: number;
  /** Safe endpoint label, e.g. "rpc:get_required_consents", "rest:profiles", "auth:user". Never a URL, id or query. */
  endpoint: string;
  method: string;
  start: number;
  /** When the response headers arrived (fetch resolved). Undefined while in flight. */
  end?: number;
  /** HTTP status; 0 when the request rejected. */
  status?: number;
  /** Screen visit that was current when the request started; null = app shell / startup before any screen. */
  visitId: number | null;
};

export type PerfVisitRecord = {
  id: number;
  screen: string;
  /** Screen focus (useFocusEffect). */
  focusAt: number;
  /** Last pointerdown before the focus, if any (web): the user's tap that started the navigation. */
  tapAt: number | null;
  /** Content was already showing at focus (e.g. returning to a screen with data). */
  readyAtFocus: boolean;
  /** First moment content was showing during this visit. */
  contentAt: number | null;
  /** Periods during the visit when content was replaced by a loading state (skeleton/spinner). */
  notReady: { start: number; end: number | null }[];
};

export type PerfVisitSummary = {
  visitId: number;
  screen: string;
  /** tap → content (null when the visit had no tap, e.g. a cold start or programmatic navigation). */
  tapToContentMs: number | null;
  focusToContentMs: number | null;
  /** Requests started from focus until content showed. */
  requestsBeforeContent: number;
  /** Longest chain of requests that each started after the previous one finished (≈ sequential round trips). */
  depthBeforeContent: number;
  /** Requests started within `windowMs` of focus, and when the last of them finished. */
  requestsInWindow: number;
  depthInWindow: number;
  settledMs: number | null;
  /** Total time content was hidden behind a loading state after having been ready (skeleton flashes). */
  notReadyMs: number;
  endpoints: Record<string, number>;
};

const EPS = 1;

/**
 * Longest dependency-like chain: depth(r) = 1 + max depth of the requests that had finished before r started.
 * Parallel requests share a depth; a request issued after another returned counts one level deeper.
 * This upper-bounds true data dependencies (an unrelated later request also counts), which is the conservative reading.
 */
export function sequentialDepth(reqs: Pick<PerfRequestRecord, "start" | "end">[]): number {
  const sorted = [...reqs].sort((a, b) => a.start - b.start);
  const depth: number[] = [];
  let max = 0;
  for (let i = 0; i < sorted.length; i++) {
    let d = 1;
    for (let j = 0; j < i; j++) {
      const prevEnd = sorted[j]!.end;
      if (prevEnd != null && prevEnd <= sorted[i]!.start + EPS) d = Math.max(d, depth[j]! + 1);
    }
    depth.push(d);
    max = Math.max(max, d);
  }
  return max;
}

export function summarizeVisit(
  visit: PerfVisitRecord,
  requests: PerfRequestRecord[],
  windowMs = 5000
): PerfVisitSummary {
  const mine = requests.filter((r) => r.visitId === visit.id);
  const contentAt = visit.contentAt;
  const beforeContent = contentAt == null ? [] : mine.filter((r) => r.start <= contentAt);
  const inWindow = mine.filter((r) => r.start <= visit.focusAt + windowMs);
  const ends = inWindow.map((r) => r.end).filter((e): e is number => e != null);
  const endpoints: Record<string, number> = {};
  for (const r of inWindow) endpoints[r.endpoint] = (endpoints[r.endpoint] ?? 0) + 1;
  let notReadyMs = 0;
  for (const p of visit.notReady) if (p.end != null) notReadyMs += p.end - p.start;
  return {
    visitId: visit.id,
    screen: visit.screen,
    tapToContentMs: contentAt != null && visit.tapAt != null ? round(contentAt - visit.tapAt) : null,
    focusToContentMs: contentAt != null ? round(Math.max(0, contentAt - visit.focusAt)) : null,
    requestsBeforeContent: beforeContent.length,
    depthBeforeContent: sequentialDepth(beforeContent),
    requestsInWindow: inWindow.length,
    depthInWindow: sequentialDepth(inWindow),
    settledMs: ends.length ? round(Math.max(...ends) - visit.focusAt) : null,
    notReadyMs: round(notReadyMs),
    endpoints,
  };
}

/** Requests made before the first screen visit: app shell bootstrap (auth, profile, gates). */
export function summarizeStartup(requests: PerfRequestRecord[]): {
  requests: number;
  depth: number;
  settledMs: number | null;
  endpoints: Record<string, number>;
} {
  const shell = requests.filter((r) => r.visitId === null);
  const ends = shell.map((r) => r.end).filter((e): e is number => e != null);
  const endpoints: Record<string, number> = {};
  for (const r of shell) endpoints[r.endpoint] = (endpoints[r.endpoint] ?? 0) + 1;
  return {
    requests: shell.length,
    depth: sequentialDepth(shell),
    settledMs: ends.length ? round(Math.max(...ends)) : null,
    endpoints,
  };
}

function round(n: number): number {
  return Math.round(n);
}
