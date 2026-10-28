/** Shared fixtures for the System issues tests (not imported by the app). */
import type { DbClient } from "./queries";
import type { SystemIssueRow } from "./types";

export function issue(over: Partial<SystemIssueRow> = {}): SystemIssueRow {
  return {
    id: "11111111-1111-4111-8111-111111111111", source: "client", subsystem: "client", operation: "rpc/postgrest", error_class: "PostgrestError", error_code: "21000",
    title: "RPC database error: 21000", latest_summary: "RPC database error: 21000", severity: "warning", base_severity: "warning", impact: null, status: "open",
    resolution: null, muted_until: null, first_seen: "2026-10-12T08:00:00Z", last_seen: "2026-10-13T08:00:00Z", occurrence_count: 3, reopen_count: 0, reopened_at: null,
    acknowledged_at: null, resolved_at: null, first_seen_version: "1.0.0", last_seen_version: "1.0.0", regressed_in_version: null,
    operation_label: null, env_history_complete: true, prod_occurrence_count: 3, prod_last_seen: "2026-10-13T08:00:00Z",
    dev_occurrence_count: 0, dev_last_seen: null, has_dev_occurrence: false, ...over,
  };
}

// ---- a recording fake of the PostgREST builder ----
export function fakeDb(respond: (table: string, calls: [string, unknown[]][]) => { data?: unknown; count?: number | null; error?: unknown }) {
  const log: { table: string; calls: [string, unknown[]][] }[] = [];
  const rpcs: { fn: string; args: unknown }[] = [];
  let rpcResult: { data: unknown; error: unknown } = { data: { ok: true, status: "open" }, error: null };
  const db: DbClient = {
    from(table: string) {
      const calls: [string, unknown[]][] = [];
      log.push({ table, calls });
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "gte", "gt", "order", "range", "limit"]) b[m] = (...a: unknown[]) => { calls.push([m, a]); return b; };
      b.maybeSingle = () => { calls.push(["maybeSingle", []]); const r = respond(table, calls); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data ?? null, error: r.error ?? null }); };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { const r = respond(table, calls); return Promise.resolve({ data: r.data ?? [], count: r.count ?? null, error: r.error ?? null }).then(res, rej); };
      return b;
    },
    rpc(fn: string, args?: Record<string, unknown>) { rpcs.push({ fn, args }); return Promise.resolve(rpcResult); },
  };
  return { db, log, rpcs, setRpc: (r: { data: unknown; error: unknown }) => { rpcResult = r; } };
}
