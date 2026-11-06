import { activeBlockingGate, type BlockingGateStatus } from "./blockingGates";

function gates(
  legal: Partial<BlockingGateStatus>,
  receipt: Partial<BlockingGateStatus>,
  subscriptionTerms: Partial<BlockingGateStatus> = {},
): BlockingGateStatus[] {
  return [
    { id: "legal", loading: false, blocks: false, ...legal },
    { id: "receipt", loading: false, blocks: false, ...receipt },
    { id: "subscriptionTerms", loading: false, blocks: false, ...subscriptionTerms },
  ];
}

describe("activeBlockingGate", () => {
  it("shows only the legal gate when legal terms and receipt details are both required", () => {
    expect(activeBlockingGate(gates({ blocks: true }, { blocks: true }))).toBe("legal");
  });

  it("shows the receipt gate once legal terms no longer block", () => {
    expect(activeBlockingGate(gates({ blocks: false }, { blocks: true }))).toBe("receipt");
  });

  it("shows the legal gate alone when it is the only requirement", () => {
    expect(activeBlockingGate(gates({ blocks: true }, {}))).toBe("legal");
  });

  it("shows nothing when every requirement is complete", () => {
    expect(activeBlockingGate(gates({}, {}))).toBeNull();
  });

  it("holds lower gates while a higher gate is still checking (e.g. reloading after acceptance)", () => {
    expect(activeBlockingGate(gates({ loading: true, blocks: true }, { blocks: true }))).toBeNull();
    expect(activeBlockingGate(gates({ loading: true }, { blocks: true }))).toBeNull();
  });

  it("is not held back by a lower gate that is still loading", () => {
    expect(activeBlockingGate(gates({ blocks: true }, { loading: true }))).toBe("legal");
  });

  it("puts subscription terms after legal terms and receipt details", () => {
    expect(activeBlockingGate(gates({ blocks: true }, {}, { blocks: true }))).toBe("legal");
    expect(activeBlockingGate(gates({}, { blocks: true }, { blocks: true }))).toBe("receipt");
    expect(activeBlockingGate(gates({}, {}, { blocks: true }))).toBe("subscriptionTerms");
  });
});
