/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { classifyRpcOutcome } from "./rpcOutcomes/classify";
import { classifyPostgrestError, REVIEWED_REASON_SHAPES } from "./rpcOutcomes/postgrestErrors";
import { DELEGATES, GLOBAL_RULES, OPERATION_RULES } from "./rpcOutcomes/registry";
import { classifyHttpStatus } from "./techReporting/transportCapture";

// Monitoring Phase 3E.2: the SERVER-side client reporting allowlist (migration 20261015100000, plus any
// later `*client_allowlist*` follow-up migration that adds more seed rows -- e.g. 20261026094140) must
// stay in step with the reviewed client-side classification. The server is the security boundary; this
// test only guards against the two drifting apart.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");
const SEED_FILES = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && /client_allowlist/i.test(f))
  .sort();
const sql = SEED_FILES.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).join("\n");
const seed = [...sql.matchAll(/^\s*\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '((?:[^']|'')*)'\),?$/gm)].map((m) => ({ op: m[1], cls: m[2], code: m[3], subsys: m[4], title: m[5].replace(/''/g, "'") }));

// Registry operations that are NOT callable by an API role (EXECUTE revoked from clients, SEC-1/SEC-2): their codes can never reach a client.
const INTERNAL = new Set(["subscription_compute_impact", "subscription_generate_or_correct_billing_period", "subscription_reserve_or_reject"]);

function technicalRegistryPairs(): string[] {
  const ops = new Set<string>([...Object.keys(OPERATION_RULES), ...Object.keys(DELEGATES)]);
  const codesOf = (op: string, seen = new Set<string>()): string[] => {
    if (seen.has(op)) return [];
    seen.add(op);
    const own = Object.keys((OPERATION_RULES as Record<string, object>)[op] ?? {});
    return [...own, ...((DELEGATES as Record<string, string[]>)[op] ?? []).flatMap((d) => codesOf(d, seen))];
  };
  const out: string[] = [];
  for (const op of ops) {
    if (op.startsWith("_") || INTERNAL.has(op)) continue;
    for (const code of new Set([...codesOf(op), ...Object.keys(GLOBAL_RULES)])) if (classifyRpcOutcome(op, code).class === "technical") out.push(`${op}|${code}`);
  }
  return out.sort();
}

describe("server allowlist seed vs the reviewed client classification", () => {
  it("the seed parses and is unique", () => {
    expect(seed.length).toBeGreaterThan(40);
    expect(new Set(seed.map((s) => `${s.op}|${s.cls}|${s.code}`)).size).toBe(seed.length);
  });

  it("every seeded RPC outcome/reason tuple is a registry TECHNICAL pair (no business, authorization, uncertain or unknown outcome)", () => {
    for (const s of seed.filter((x) => x.cls === "RpcOutcome" || x.cls === "RpcReason")) {
      expect(s.op.startsWith("rpc/")).toBe(true);
      const op = s.op.slice(4);
      expect(classifyRpcOutcome(op, s.code).class).toBe("technical");
      if (s.cls === "RpcReason") expect(Object.keys(REVIEWED_REASON_SHAPES)).toContain(op);
      expect(INTERNAL.has(op)).toBe(false);
    }
  });

  it("every technical registry pair of a client-callable operation is seeded (as an outcome, or as a reviewed reason)", () => {
    const seeded = new Set(seed.filter((x) => x.cls === "RpcOutcome" || x.cls === "RpcReason").map((x) => `${x.op.slice(4)}|${x.code}`));
    expect([...seeded].sort()).toEqual(technicalRegistryPairs());
  });

  it("every seeded PostgREST/SQLSTATE tuple is classified technical by the client classifier and is an exact code", () => {
    for (const s of seed.filter((x) => x.cls === "PostgrestError")) {
      expect(s.op).toBe("rpc/postgrest");
      expect(s.code).toMatch(/^([0-9A-Z]{5}|PGRST[0-9]{3})$/);
      expect(s.code).not.toBe("P0001");
      expect(classifyPostgrestError("some_rpc", { code: s.code, message: "m" }).class).toBe("technical");
    }
  });

  it("transport tuples are exactly the approved 5xx statuses and the transport layer reports them", () => {
    const t = seed.filter((x) => x.cls === "HttpError").map((x) => `${x.op}|${x.code}`).sort();
    expect(t).toEqual(["transport/infra|http_502", "transport/infra|http_503", "transport/infra|http_504", "transport/server|http_500"]);
    for (const s of seed.filter((x) => x.cls === "HttpError")) expect(classifyHttpStatus("rpc", Number(s.code.slice(5))).report).toBe(true);
  });

  it("no seeded class other than the four approved ones, no wildcard, no critical", () => {
    expect([...new Set(seed.map((s) => s.cls))].sort()).toEqual(["HttpError", "PostgrestError", "RpcOutcome", "RpcReason"]);
    for (const s of seed) { expect(s.op).not.toMatch(/\*/); expect(s.title.length).toBeLessThanOrEqual(160); expect(s.title).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/); }
    expect(sql).toMatch(/severity_cap, authorizes_client|severity_cap,\s*authorizes_client/);
    expect(sql).not.toMatch(/'critical', true/);
  });

  it("the migration does not touch client_ingest_enabled, cron or business tables", () => {
    expect(sql).not.toMatch(/update public\.system_monitoring_config[^;]*client_ingest_enabled/i);
    expect(sql).not.toMatch(/cron\.schedule|cron\.alter_job|cron\.unschedule/i);
    expect(sql).not.toMatch(/(insert into|update|delete from|alter table)\s+public\.(subscriptions|session_registrations|profiles|documents|training_sessions)/i);
  });
});
