import { DELEGATES, DYNAMIC_ERROR_SITES, GLOBAL_RULES, OPERATION_RULES } from "./registry";
import type { Classification, RuleEntry } from "./types";

/** The shape of a registry. The real one is assembled from registry.ts; tests pass synthetic ones. */
export interface OutcomeRegistry {
  readonly globalRules: Readonly<Record<string, RuleEntry>>;
  readonly operationRules: Readonly<Record<string, Readonly<Record<string, RuleEntry>>>>;
  readonly delegates: Readonly<Record<string, readonly string[]>>;
  readonly dynamicErrorSites: Readonly<Record<string, readonly string[]>>;
}

export const REGISTRY: OutcomeRegistry = {
  globalRules: GLOBAL_RULES,
  operationRules: OPERATION_RULES,
  delegates: DELEGATES,
  dynamicErrorSites: DYNAMIC_ERROR_SITES,
};

function unpack(entry: RuleEntry): { cls: Classification["class"]; rationale?: string } {
  return typeof entry === "string" ? { cls: entry } : { cls: entry[0], rationale: entry[1] };
}

// Own-property lookups only: a code such as "constructor" or "__proto__" must not resolve through the prototype.
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Classify one RPC outcome against a registry. PURE: no network, no database, no logging, and no state is read or
 * written other than the (read-only) registry argument.
 *
 * Resolution order (first match wins):
 *   1. an operation-specific rule for exactly (operation, code)
 *   2. a rule of a delegate operation the operation is declared to relay (directly or through a chain of relays)
 *   3. a global rule (only for codes with identical meaning everywhere)
 *   4. otherwise `unknown`
 *
 * There is NO naming heuristic: `not_x`, `invalid_x`, `already_x`, `x_required` are `unknown` unless registered.
 * Matching is exact and case-sensitive on the code string as returned by the RPC.
 */
export function classifyWith(registry: OutcomeRegistry, operation: string, code: string): Classification {
  const dynamicErrorPossible = has(registry.dynamicErrorSites, operation) ? true : undefined;
  const base = { operation, code, ...(dynamicErrorPossible ? { dynamicErrorPossible } : {}) };

  if (has(registry.operationRules, operation)) {
    const rules = registry.operationRules[operation];
    if (has(rules, code)) {
      const { cls, rationale } = unpack(rules[code]);
      return { ...base, class: cls, source: "operation", ...(rationale ? { rationale } : {}) };
    }
  }

  // Relay chain: breadth-first through the declared direct relays (cycle-safe, deterministic declaration order).
  const seen = new Set<string>([operation]);
  const queue: string[] = has(registry.delegates, operation) ? [...registry.delegates[operation]] : [];
  while (queue.length > 0) {
    const delegate = queue.shift() as string;
    if (seen.has(delegate)) continue;
    seen.add(delegate);
    if (has(registry.operationRules, delegate) && has(registry.operationRules[delegate], code)) {
      const { cls, rationale } = unpack(registry.operationRules[delegate][code]);
      return { ...base, class: cls, source: "delegate", via: delegate, ...(rationale ? { rationale } : {}) };
    }
    if (has(registry.delegates, delegate)) queue.push(...registry.delegates[delegate]);
  }

  if (has(registry.globalRules, code)) {
    const { cls, rationale } = unpack(registry.globalRules[code]);
    return { ...base, class: cls, source: "global", ...(rationale ? { rationale } : {}) };
  }

  return { ...base, class: "unknown", source: "none" };
}

/** Classify against the real, source-controlled registry. */
export function classifyRpcOutcome(operation: string, code: string): Classification {
  return classifyWith(REGISTRY, operation, code);
}
