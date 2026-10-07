/// <reference types="node" />
/**
 * Completeness check: the registry must account for every outcome the CURRENT migrations can return.
 * Failing messages say exactly what needs review. See README.md for the extraction limits.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { classifyWith, REGISTRY } from "./classify";
import { extractInventory, type Inventory } from "./extract";
import { CODE_BEARING_KEYS, CONSUMED_CALLS, DELEGATES, DYNAMIC_ERROR_SITES, GLOBAL_RULES, OPERATION_RULES } from "./registry";
import type { RuleEntry } from "./types";

const MIGRATIONS = path.resolve(__dirname, "../../../../supabase/migrations");
const CLASSES = ["business", "authorization_validation", "technical", "uncertain"];
const keysOf = (codeBearing: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(Object.entries(codeBearing).map(([k, v]) => [k, [...v]]));

const cls = (e: RuleEntry) => (typeof e === "string" ? e : e[0]);
const rationale = (e: RuleEntry) => (typeof e === "string" ? undefined : e[1]);

let inv: Inventory;
beforeAll(() => {
  inv = extractInventory(MIGRATIONS, keysOf(CODE_BEARING_KEYS));
});

describe("registry completeness against the current migrations", () => {
  it("extracts a plausible inventory (guards against the extractor silently finding nothing)", () => {
    expect(inv.liveFunctionCount).toBeGreaterThan(300);
    expect(inv.pairs.size).toBeGreaterThan(400);
  });

  it("every (operation, code) the migrations can return is classified (new outcomes need review)", () => {
    const unclassified = [...inv.pairs.values()]
      .filter((p) => classifyWith(REGISTRY, p.operation, p.code).class === "unknown")
      .map((p) => `${p.operation} -> '${p.code}' (${p.kind})`)
      .sort();
    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} outcome(s) need classification in src/lib/rpcOutcomes/registry.ts ` +
          `(business | authorization_validation | technical | uncertain):\n  ${unclassified.join("\n  ")}`
      );
    }
  });

  it("every operation-specific rule still corresponds to a code the operation can return (no stale entries)", () => {
    const stale: string[] = [];
    for (const [op, rules] of Object.entries(OPERATION_RULES)) {
      for (const code of Object.keys(rules)) {
        if (!inv.pairs.has(`${op}|${code}`)) stale.push(`${op} -> '${code}'`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("every global rule is used by at least one operation", () => {
    const used = new Set([...inv.pairs.values()].map((p) => p.code));
    expect(Object.keys(GLOBAL_RULES).filter((c) => !used.has(c))).toEqual([]);
  });

  it("an operation rule that contradicts a global rule must say why", () => {
    const missing: string[] = [];
    for (const [op, rules] of Object.entries(OPERATION_RULES)) {
      for (const [code, entry] of Object.entries(rules)) {
        const g = GLOBAL_RULES[code];
        if (g && cls(g) !== cls(entry) && !rationale(entry)) missing.push(`${op} -> '${code}'`);
        if (g && cls(g) === cls(entry)) missing.push(`${op} -> '${code}' (redundant: identical to the global rule)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("technical and uncertain rules carry a rationale", () => {
    const missing: string[] = [];
    for (const [op, rules] of Object.entries(OPERATION_RULES)) {
      for (const [code, entry] of Object.entries(rules)) {
        if ((cls(entry) === "technical" || cls(entry) === "uncertain") && !rationale(entry)) missing.push(`${op} -> '${code}'`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every code string is a plain literal (no wildcards) and every class is valid", () => {
    const bad: string[] = [];
    const check = (where: string, code: string, e: RuleEntry) => {
      if (!/^[a-z0-9_:.\-]+$/.test(code)) bad.push(`${where} -> '${code}' is not a plain code`);
      if (!CLASSES.includes(cls(e))) bad.push(`${where} -> '${code}' has invalid class '${cls(e)}'`);
    };
    for (const [code, e] of Object.entries(GLOBAL_RULES)) check("global", code, e);
    for (const [op, rules] of Object.entries(OPERATION_RULES)) for (const [code, e] of Object.entries(rules)) check(op, code, e);
    expect(bad).toEqual([]);
  });

  it("relays declared in DELEGATES match real calls, and every call between outcome emitters is reviewed", () => {
    const declared = new Set<string>();
    for (const [caller, callees] of Object.entries(DELEGATES)) for (const c of callees) declared.add(`${caller}->${c}`);
    const consumed = new Set<string>();
    for (const [caller, callees] of Object.entries(CONSUMED_CALLS)) for (const c of Object.keys(callees)) consumed.add(`${caller}->${c}`);

    const both = [...declared].filter((e) => consumed.has(e));
    expect(both).toEqual([]);
    const notCalled = [...declared, ...consumed].filter((e) => !inv.callEdges.has(e)).sort();
    expect(notCalled).toEqual([]);
    const unreviewed = [...inv.callEdges].filter((e) => !declared.has(e) && !consumed.has(e)).sort();
    if (unreviewed.length > 0) {
      throw new Error(
        `New call(s) between outcome-emitting functions need review: add each to DELEGATES (its result/codes are ` +
          `returned to the caller) or CONSUMED_CALLS (result swallowed/aggregated):\n  ${unreviewed.join("\n  ")}`
      );
    }
  });

  it("dynamic (non-literal) error sites are exactly the declared ones", () => {
    const found = Object.fromEntries([...inv.dynamicSites.entries()].map(([op, kinds]) => [op, [...kinds].sort()]));
    const declared = Object.fromEntries(Object.entries(DYNAMIC_ERROR_SITES).map(([op, kinds]) => [op, [...kinds].sort()]));
    expect(Object.keys(found).sort()).toEqual(Object.keys(declared).sort());
    expect(found).toEqual(declared);
  });

  it("every delegate and CONSUMED_CALLS operation is itself an outcome emitter known to the extractor", () => {
    const emitters = new Set([...inv.pairs.values()].map((p) => p.operation));
    for (const op of inv.dynamicSites.keys()) emitters.add(op);
    const missing: string[] = [];
    for (const callees of Object.values(DELEGATES)) for (const c of callees) if (!emitters.has(c)) missing.push(c);
    expect(missing).toEqual([]);
  });

  it("prints a classification summary (informational)", () => {
    const counts: Record<string, number> = {};
    for (const p of inv.pairs.values()) {
      const c = classifyWith(REGISTRY, p.operation, p.code).class;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    console.info(
      `RPC outcomes: ${inv.pairs.size} operation/code pairs, ${new Set([...inv.pairs.values()].map((p) => p.code)).size} distinct codes, ` +
        `${new Set([...inv.pairs.values()].map((p) => p.operation)).size} operations; classes ${JSON.stringify(counts)}`
    );
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(inv.pairs.size);
  });
});

describe("extractor behaviour on synthetic migrations (formatting robustness and detection)", () => {
  function inventoryOf(files: Record<string, string>, codeBearing: Record<string, string[]> = {}): Inventory {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-outcomes-"));
    try {
      for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
      return extractInventory(dir, codeBearing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const codes = (i: Inventory) => [...i.pairs.keys()].sort();

  it("detects a new code regardless of SQL formatting (case, whitespace, newlines, json vs jsonb, dollar-tag)", () => {
    const i = inventoryOf({
      "20260101000000_a.sql": `
        CREATE OR REPLACE FUNCTION public.f1(p int)
        RETURNS json LANGUAGE plpgsql AS $fn$
        BEGIN
          RETURN json_build_object(
            'ok',   false,
            'error',
               'new_code'
          );
        END; $fn$;
        create function f2() returns jsonb language sql as $$ select jsonb_build_object('ok',false,'error','other_code') $$;
        create function public.f3() returns json language plpgsql as $$ begin return '{"ok": false, "error": "json_text_code"}'::json; end; $$;`,
    });
    expect(codes(i)).toEqual(["f1|new_code", "f2|other_code", "f3|json_text_code"]);
  });

  it("uses only the LATEST definition of a function and honours DROP FUNCTION", () => {
    const i = inventoryOf({
      "20260101000000_a.sql": `create function public.g(a int) returns json language plpgsql as $$ begin return json_build_object('ok',false,'error','old_code'); end; $$;
                               create function public.h() returns json language plpgsql as $$ begin return json_build_object('ok',false,'error','h_code'); end; $$;`,
      "20260102000000_b.sql": `create or replace function public.g(a int) returns json language plpgsql as $$ begin return json_build_object('ok',false,'error','new_code'); end; $$;
                               drop function if exists public.h();`,
    });
    expect(codes(i)).toEqual(["g|new_code"]);
  });

  it("detects RAISE EXCEPTION tokens, extra code-bearing keys and non-literal error sites", () => {
    const i = inventoryOf(
      {
        "20260101000000_a.sql": `
          create function public.r() returns void language plpgsql as $$ begin raise exception 'thrown_token'; end; $$;
          create function public.k() returns json language plpgsql as $$ begin return json_build_object('ok', false, 'error', 'not_revertible', 'reason', 'because_x'); end; $$;
          create function public.d() returns json language plpgsql as $$ begin exception when others then return json_build_object('ok', false, 'error', SQLERRM); end; $$;
          create function public.rel() returns json language plpgsql as $$ declare v json; begin v := public.k(); return json_build_object('ok', false, 'error', v->>'error'); end; $$;`,
      },
      { k: ["error", "reason"] }
    );
    expect(codes(i)).toEqual(["k|because_x", "k|not_revertible", "r|thrown_token"]);
    expect([...i.dynamicSites.keys()].sort()).toEqual(["d", "rel"]);
    expect([...i.callEdges]).toEqual(["rel->k"]);
  });

  it("does NOT see codes built at runtime (documented limitation; such sites must be declared by hand)", () => {
    const i = inventoryOf({
      "20260101000000_a.sql": `create function public.m(p text) returns json language plpgsql as $$ declare c text := 'x_' || p; begin return json_build_object('ok', false, 'error', c); end; $$;`,
    });
    expect(codes(i)).toEqual([]);
    // ...but the non-literal error site IS reported, so the registry must declare it explicitly:
    expect([...i.dynamicSites.keys()]).toEqual(["m"]);
  });
});

describe("mutation checks: the completeness mechanism really notices change", () => {
  function realMigrationsPlus(extra: Record<string, string>): Inventory {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-outcomes-real-"));
    try {
      for (const f of fs.readdirSync(MIGRATIONS)) if (/\.sql$/.test(f)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
      for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), sql);
      return extractInventory(dir, keysOf(CODE_BEARING_KEYS));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a developer adding a new code to a function surfaces it as unclassified", () => {
    const i = realMigrationsPlus({
      "99990101000000_dev_change.sql": `create or replace function public.register_for_session(p_session_id uuid, p_accept boolean default false)
        returns json language plpgsql as $$ begin return jsonb_build_object('ok', false, 'error', 'new_code'); end; $$;`,
    });
    const unclassified = [...i.pairs.values()].filter((p) => classifyWith(REGISTRY, p.operation, p.code).class === "unknown");
    expect(unclassified.map((p) => `${p.operation}|${p.code}`)).toEqual(["register_for_session|new_code"]);
    // and the redefinition really replaced the old body: the old register codes are gone from the live inventory
    expect(i.pairs.has("register_for_session|already_registered")).toBe(false);
  });

  it("a brand-new RPC with a code that exists elsewhere is still flagged (known string, unregistered operation)", () => {
    const i = realMigrationsPlus({
      "99990101000000_dev_change.sql": `create function public.brand_new_rpc() returns json language plpgsql as $$ begin return json_build_object('ok', false, 'error', 'full'); end; $$;`,
    });
    const unclassified = [...i.pairs.values()].filter((p) => classifyWith(REGISTRY, p.operation, p.code).class === "unknown");
    expect(unclassified.map((p) => `${p.operation}|${p.code}`)).toEqual(["brand_new_rpc|full"]);
  });

  it("a new global-covered code on a new operation is NOT flagged (by design: universal codes)", () => {
    const i = realMigrationsPlus({
      "99990101000000_dev_change.sql": `create function public.brand_new_rpc() returns json language plpgsql as $$ begin return json_build_object('ok', false, 'error', 'forbidden'); end; $$;`,
    });
    expect([...i.pairs.values()].filter((p) => classifyWith(REGISTRY, p.operation, p.code).class === "unknown")).toEqual([]);
  });

  it("removing a code from a function leaves a stale registry entry that is detected", () => {
    const i = realMigrationsPlus({
      "99990101000000_dev_change.sql": `create or replace function public.register_for_session(p_session_id uuid, p_accept boolean default false)
        returns json language plpgsql as $$ begin return json_build_object('ok', true); end; $$;`,
    });
    const stale = Object.entries(OPERATION_RULES).flatMap(([op, rules]) => Object.keys(rules).filter((c) => !i.pairs.has(`${op}|${c}`)).map((c) => `${op}|${c}`));
    expect(stale).toContain("register_for_session|already_registered");
  });

  it("a new call between outcome emitters is detected as an unreviewed edge", () => {
    const i = realMigrationsPlus({
      "99990101000000_dev_change.sql": `create function public.wrapper_rpc() returns json language plpgsql as $$ begin return json_build_object('ok', false, 'error', 'forbidden') ; end; $$;
        create or replace function public.wrapper_rpc() returns json language plpgsql as $$ declare v json; begin v := public.register_for_session(null); return v; end; $$;`,
    });
    expect(i.callEdges.has("wrapper_rpc->register_for_session")).toBe(true);
    const declared = new Set(Object.entries(DELEGATES).flatMap(([a, bs]) => bs.map((b) => `${a}->${b}`)));
    expect(declared.has("wrapper_rpc->register_for_session")).toBe(false);
  });

  it("a registry with an entry removed reports that pair as unclassified", () => {
    const withoutOne = {
      ...REGISTRY,
      operationRules: { ...OPERATION_RULES, cancel_registration: { ...OPERATION_RULES.cancel_registration } },
    };
    delete (withoutOne.operationRules.cancel_registration as Record<string, RuleEntry>).not_registered;
    expect(classifyWith(withoutOne, "cancel_registration", "not_registered").class).toBe("unknown");
    expect(classifyWith(REGISTRY, "cancel_registration", "not_registered").class).toBe("business");
  });
});

describe("existing client-side interpreters agree with the registry", () => {
  const LIB = path.resolve(__dirname, "..");
  function handledCodes(file: string, stopAt?: string): string[] {
    let src = fs.readFileSync(path.join(LIB, file), "utf8");
    if (stopAt && src.includes(stopAt)) src = src.slice(0, src.indexOf(stopAt));
    return [...src.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]);
  }
  it("every code athleteRegisterSessionErrorDetail translates for register_for_session is a registered, non-technical outcome", () => {
    const codes = handledCodes("athleteRegisterSessionError.ts", "export function athleteSubscriptionLimitMessage");
    expect(codes.length).toBeGreaterThanOrEqual(7);
    for (const code of codes) {
      expect(["business", "authorization_validation"]).toContain(classifyWith(REGISTRY, "register_for_session", code).class);
    }
  });
  it("every code moveParticipantErrors translates for staff_move_session_participant is a registered, non-technical outcome", () => {
    const src = fs.readFileSync(path.join(LIB, "moveParticipantErrors.ts"), "utf8");
    const head = src.split("case \"subscription_limit_exceeded\"")[0];
    const codes = [...head.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of [...codes, "subscription_limit_exceeded"]) {
      expect(["business", "authorization_validation"]).toContain(classifyWith(REGISTRY, "staff_move_session_participant", code).class);
    }
  });
});
