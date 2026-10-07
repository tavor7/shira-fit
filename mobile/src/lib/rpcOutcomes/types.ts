/**
 * RPC outcome classification types (Phase 3A: classification only; nothing here reports anything).
 */

/** Classes a REGISTERED rule may carry. */
export type RegisteredOutcomeClass =
  /** Expected product behaviour (full session, stale reference, state-dependent refusal). Never a monitoring issue. */
  | "business"
  /** Expected authentication / authorization / input-validation refusal. Not a technical incident. */
  | "authorization_validation"
  /** Unexpected/internal failure or violated invariant: eligible for technical monitoring. */
  | "technical"
  /** Reviewed, but the evidence does not decide the class. Needs a product or implementation decision. */
  | "uncertain";

/** What a lookup can return: a registered class, or `unknown` when nobody classified the pair. */
export type OutcomeClass = RegisteredOutcomeClass | "unknown";

/** A rule is a bare class, or [class, rationale]. */
export type RuleEntry = RegisteredOutcomeClass | readonly [RegisteredOutcomeClass, string];

export type RuleSource =
  /** An operation-specific rule for exactly this operation + code. */
  | "operation"
  /** The operation relays the result of a delegate operation, and the delegate has a rule for this code. */
  | "delegate"
  /** A global rule (only codes whose meaning is identical in every operation). */
  | "global"
  /** Nothing matched. */
  | "none";

export interface Classification {
  readonly operation: string;
  readonly code: string;
  readonly class: OutcomeClass;
  readonly source: RuleSource;
  /** The delegate operation whose rule matched (source === "delegate"). */
  readonly via?: string;
  readonly rationale?: string;
  /**
   * Set when the operation can return raw SQLERRM text (or another non-literal value) as its `error`.
   * Such text is NOT a code: it is looked up like any other string and is `unknown` unless a rule matches.
   */
  readonly dynamicErrorPossible?: boolean;
}
