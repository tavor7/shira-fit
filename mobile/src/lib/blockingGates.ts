export type BlockingGateId = "legal" | "receipt" | "subscriptionTerms";

export type BlockingGateStatus = {
  id: BlockingGateId;
  /** Still deciding whether this gate applies. */
  loading: boolean;
  /** Last known answer: this gate must be completed before the app can be used. */
  blocks: boolean;
};

/**
 * Which mandatory gate, if any, is shown now. `gates` is in priority order; only one is ever shown, so two blocking
 * overlays can never sit on top of each other (on web each overlay marks its siblings `inert`, so two at once made
 * both untouchable). A lower gate waits until every gate above it has finished checking and does not block.
 */
export function activeBlockingGate(gates: readonly BlockingGateStatus[]): BlockingGateId | null {
  for (const gate of gates) {
    if (gate.loading) return null;
    if (gate.blocks) return gate.id;
  }
  return null;
}
