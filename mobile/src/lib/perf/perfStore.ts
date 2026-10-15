import { isPerfEnabled } from "./perfFlag";
import {
  summarizeStartup,
  summarizeVisit,
  type PerfRequestRecord,
  type PerfVisitRecord,
  type PerfVisitSummary,
} from "./perfAnalysis";

/**
 * In-memory recorder for the performance instrumentation (docs/performance/README.md). Only ever written when
 * `isPerfEnabled()` is true. Holds endpoint labels, HTTP methods/statuses, screen names and timings - no URLs, ids,
 * query strings, headers, bodies or user data - in bounded ring buffers. Nothing is persisted or sent anywhere; the
 * data is read from the PerfPanel ("Copy JSON") or by the local measurement harness via `globalThis.__SF_PERF__`.
 */

const MAX_REQUESTS = 2000;
const MAX_VISITS = 300;

export type PerfSnapshot = {
  version: 1;
  capturedAt: string;
  /** performance.now() when this module was first evaluated (≈ JS bundle start). */
  jsStartAt: number;
  requests: PerfRequestRecord[];
  visits: PerfVisitRecord[];
  startup: ReturnType<typeof summarizeStartup>;
  summaries: PerfVisitSummary[];
};

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

const jsStartAt = now();
let requests: PerfRequestRecord[] = [];
let visits: PerfVisitRecord[] = [];
let nextRequestId = 1;
let nextVisitId = 1;
let currentVisitId: number | null = null;
let lastPointerDownAt: number | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pointerdown", perfNotePointerDown, { capture: true, passive: true });
    }
    (globalThis as { __SF_PERF__?: unknown }).__SF_PERF__ = { snapshot: perfSnapshot, clear: perfClear };
  } catch {
    /* instrumentation must never affect the app */
  }
}

/** Called on every pointerdown (web) while instrumentation is enabled; exported for tests. */
export function perfNotePointerDown(): void {
  lastPointerDownAt = now();
}

function push<T>(list: T[], item: T, max: number): T[] {
  list.push(item);
  return list.length > max ? list.slice(list.length - max) : list;
}

export function perfRequestStart(endpoint: string, method: string): number | null {
  if (!isPerfEnabled()) return null;
  install();
  const id = nextRequestId++;
  requests = push(requests, { id, endpoint, method, start: now(), visitId: currentVisitId }, MAX_REQUESTS);
  return id;
}

export function perfRequestEnd(id: number | null, status: number): void {
  if (id == null) return;
  const r = requests.find((x) => x.id === id);
  if (r) {
    r.end = now();
    r.status = status;
  }
}

/** A screen gained focus. `ready` = its content is already showing (no loading state). */
export function perfBeginVisit(screen: string, ready: boolean): number | null {
  if (!isPerfEnabled()) return null;
  install();
  const at = now();
  const id = nextVisitId++;
  // A tap counts for this navigation only if it happened shortly before the focus. It is not consumed: a screen and an
  // instrumented component inside it (whose focus effect runs first) both belong to the same tap.
  const tapAt = lastPointerDownAt != null && at - lastPointerDownAt < 3000 ? lastPointerDownAt : null;
  visits = push(visits, { id, screen, focusAt: at, tapAt, readyAtFocus: ready, contentAt: ready ? at : null, notReady: [] }, MAX_VISITS);
  currentVisitId = id;
  return id;
}

/** The screen's content-showing state changed during a visit. */
export function perfSetReady(visitId: number | null, ready: boolean): void {
  if (visitId == null) return;
  const v = visits.find((x) => x.id === visitId);
  if (!v) return;
  const at = now();
  if (ready) {
    if (v.contentAt == null) v.contentAt = at;
    const open = v.notReady[v.notReady.length - 1];
    if (open && open.end == null) open.end = at;
  } else if (v.contentAt != null) {
    const open = v.notReady[v.notReady.length - 1];
    if (!open || open.end != null) v.notReady.push({ start: at, end: null });
  }
}

export function perfSnapshot(): PerfSnapshot {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    jsStartAt,
    requests: requests.map((r) => ({ ...r })),
    visits: visits.map((v) => ({ ...v, notReady: v.notReady.map((p) => ({ ...p })) })),
    startup: summarizeStartup(requests),
    summaries: visits.map((v) => summarizeVisit(v, requests)),
  };
}

export function perfClear(): void {
  requests = [];
  visits = [];
  currentVisitId = null;
}
