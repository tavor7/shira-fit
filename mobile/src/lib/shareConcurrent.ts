/**
 * Wraps a no-argument async read so that callers in the same JS task share one request.
 *
 * Performance Phase 2: the app-wide gates (legal consent, receipt requirements, manager message) each read the same
 * server state when they mount and on every resume, in the same commit / event dispatch, so the app sent
 * get_required_consents twice and get_address_collection_required twice each time. Nothing is cached: the shared
 * promise is dropped at the next macrotask, before it settles, so any later call (e.g. the reload right after the user
 * accepts or saves) always sends a fresh request and can never receive an answer computed before its own call.
 */
export function shareConcurrent<T>(fn: () => Promise<T>): () => Promise<T> {
  let shared: Promise<T> | null = null;
  return () => {
    if (shared) return shared;
    const p = fn();
    shared = p;
    setTimeout(() => {
      if (shared === p) shared = null;
    }, 0);
    return p;
  };
}
