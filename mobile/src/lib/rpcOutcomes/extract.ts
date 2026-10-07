/// <reference types="node" />
/**
 * Static extraction of RPC outcome codes from the SQL migrations (Phase 3A).
 *
 * TEST/TOOLING ONLY: this module reads the filesystem and must never be imported by application code.
 *
 * What it does: replays `create [or replace] function` / `drop function` statements in migration-file order
 * (so only the LATEST live definition of each function counts, keyed by name + argument count), then scans each
 * live body for the outcome codes the function can return.
 *
 * What it can detect (and therefore what the completeness test enforces):
 *   - literal codes in the JSON-building forms        'error', 'some_code'      (json_build_object / jsonb_build_object)
 *   - literal codes in JSON text forms                "error": "some_code"
 *   - literal tokens in                               RAISE EXCEPTION 'some_token'
 *   - literal codes under extra code-bearing keys     declared per operation in CODE_BEARING_KEYS (e.g. 'reason')
 *   - NON-literal `'error', <expression>` sites       (raw SQLERRM, relayed variables, coalesce(...)) -> reported as
 *                                                     "dynamic sites"; their possible values cannot be enumerated
 *   - calls from one outcome-emitting function to another (call edges) so relays can be reviewed
 *
 * What it can NOT detect (documented, not hidden):
 *   - codes assembled at runtime (string concatenation, format(), values read from a table or a variable)
 *   - codes inside dynamically executed SQL (EXECUTE) or functions created by DO blocks
 *   - result shapes that do not use the `error` key (those must be declared in CODE_BEARING_KEYS)
 *   - overloads that differ only by argument TYPES with the same argument count (they are merged by name)
 *   - functions defined outside supabase/migrations (dashboard edits, extensions)
 * The dynamic-site report and the call-edge report exist precisely so that these gaps become visible to review.
 */
import * as fs from "fs";
import * as path from "path";

export type OutcomeKind = "returned" | "raised";

export interface ExtractedPair {
  operation: string;
  code: string;
  kind: OutcomeKind;
}

export interface Inventory {
  /** key = `${operation}|${code}` */
  pairs: Map<string, ExtractedPair>;
  /** operations containing `'error', <non-literal>` sites -> short descriptions of the expressions */
  dynamicSites: Map<string, string[]>;
  /** `${caller}->${callee}` where both functions emit outcome codes */
  callEdges: Set<string>;
  /** number of live function definitions scanned */
  liveFunctionCount: number;
}

/** Operations whose result carries codes under keys other than `error`. */
export type CodeBearingKeys = Record<string, string[]>;

const CODE = "[a-z0-9_:.\\-]+";

function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter((a) => a.trim());
}

interface LiveFunction {
  name: string;
  arity: number;
  body: string;
}

function replayMigrations(migrationsDir: string): Map<string, LiveFunction> {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const live = new Map<string, LiveFunction>();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    type Ev =
      | { pos: number; type: "create"; fn: LiveFunction }
      | { pos: number; type: "drop"; name: string; arity: number };
    const events: Ev[] = [];

    const createRe = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_0-9]+)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql))) {
      let i = createRe.lastIndex;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        const c = sql[i++];
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      const args = sql.slice(createRe.lastIndex, i - 1);
      const rest = sql.slice(i);
      const quote = /\$([a-z_0-9]*)\$/i.exec(rest);
      if (!quote) continue;
      const tag = quote[0];
      const start = quote.index + tag.length;
      const end = rest.indexOf(tag, start);
      if (end < 0) continue;
      events.push({
        pos: m.index,
        type: "create",
        fn: { name: m[1].toLowerCase(), arity: splitTopLevel(args).length, body: rest.slice(start, end) },
      });
    }

    const dropRe = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s*\(([^)]*)\)/gi;
    while ((m = dropRe.exec(sql))) {
      events.push({ pos: m.index, type: "drop", name: m[1].toLowerCase(), arity: splitTopLevel(m[2]).length });
    }

    events.sort((a, b) => a.pos - b.pos);
    for (const ev of events) {
      if (ev.type === "create") live.set(`${ev.fn.name}/${ev.fn.arity}`, ev.fn);
      else live.delete(`${ev.name}/${ev.arity}`);
    }
  }
  return live;
}

export function extractInventory(migrationsDir: string, codeBearingKeys: CodeBearingKeys = {}): Inventory {
  const live = replayMigrations(migrationsDir);
  const pairs = new Map<string, ExtractedPair>();
  const dynamicSites = new Map<string, string[]>();
  const add = (operation: string, code: string, kind: OutcomeKind) => {
    const key = `${operation}|${code}`;
    if (!pairs.has(key)) pairs.set(key, { operation, code, kind });
  };

  for (const fn of live.values()) {
    const keys = codeBearingKeys[fn.name] ?? ["error"];
    for (const key of keys) {
      const lit = new RegExp(`'${key}'\\s*,\\s*'(${CODE})'|"${key}"\\s*:\\s*"(${CODE})"`, "gi");
      let m: RegExpExecArray | null;
      while ((m = lit.exec(fn.body))) add(fn.name, (m[1] ?? m[2]).toLowerCase(), "returned");
    }
    const raise = new RegExp(`raise\\s+exception\\s+'(${CODE})'`, "gi");
    let r: RegExpExecArray | null;
    while ((r = raise.exec(fn.body))) add(fn.name, r[1].toLowerCase(), "raised");

    const dyn = /'error'\s*,\s*(?!')([a-z_][a-z_0-9.]*(?:\s*\(|\s*->>)?)/gi;
    let d: RegExpExecArray | null;
    while ((d = dyn.exec(fn.body))) {
      const list = dynamicSites.get(fn.name) ?? [];
      const desc = d[1].replace(/\s+/g, " ").toLowerCase();
      if (!list.includes(desc)) list.push(desc);
      dynamicSites.set(fn.name, list);
    }
  }

  const emitters = new Set([...pairs.values()].map((p) => p.operation));
  for (const op of dynamicSites.keys()) emitters.add(op);
  const callEdges = new Set<string>();
  for (const fn of live.values()) {
    for (const callee of emitters) {
      if (callee === fn.name) continue;
      if (new RegExp(`(?<![a-z0-9_])(?:public\\.)?${callee}\\s*\\(`, "i").test(fn.body)) {
        callEdges.add(`${fn.name}->${callee}`);
      }
    }
  }
  return { pairs, dynamicSites, callEdges, liveFunctionCount: live.size };
}
