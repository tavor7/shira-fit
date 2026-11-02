import {
  NO_UNKNOWN_FINANCE,
  anyFinanceUnknown,
  expectedTotalUnknown,
  paymentLockUnknown,
  rpcLookupFailed,
  unknownFinanceItems,
} from "./rosterFinanceLookups";

describe("rosterFinanceLookups", () => {
  it("an ok RPC result is not a failure, including a genuinely empty one", () => {
    expect(rpcLookupFailed({ data: { ok: true, covered_user_ids: [], covered_manual_ids: [] }, error: null })).toBe(false);
    expect(rpcLookupFailed({ data: { ok: true, locked_user_ids: ["u1"] }, error: null })).toBe(false);
  });

  it("server errors, network drops and unexpected ok:false are failures", () => {
    expect(rpcLookupFailed({ data: null, error: { message: "TypeError: Failed to fetch" } })).toBe(true);
    expect(rpcLookupFailed({ data: null, error: { message: "500" } })).toBe(true);
    expect(rpcLookupFailed({ data: { ok: false, error: "not_authenticated" }, error: null })).toBe(true);
    expect(rpcLookupFailed({ data: null, error: null })).toBe(true);
    expect(rpcLookupFailed(undefined)).toBe(true);
  });

  it("forbidden (a viewer who may not see this session's finance) is by design, not a failure", () => {
    expect(rpcLookupFailed({ data: { ok: false, error: "forbidden" }, error: null })).toBe(false);
  });

  it("the expected total is unknown when coverage, prices or a participant list failed — not for locks / rates", () => {
    expect(expectedTotalUnknown(NO_UNKNOWN_FINANCE)).toBe(false);
    for (const k of ["coverage", "prices", "participants"] as const) {
      expect(expectedTotalUnknown({ ...NO_UNKNOWN_FINANCE, [k]: true })).toBe(true);
    }
    for (const k of ["locks", "rates"] as const) {
      expect(expectedTotalUnknown({ ...NO_UNKNOWN_FINANCE, [k]: true })).toBe(false);
      expect(anyFinanceUnknown({ ...NO_UNKNOWN_FINANCE, [k]: true })).toBe(true);
    }
    expect(anyFinanceUnknown(NO_UNKNOWN_FINANCE)).toBe(false);
  });

  it("unknown locks pause editing only rows with a recorded payment", () => {
    const u = { ...NO_UNKNOWN_FINANCE, locks: true };
    expect(paymentLockUnknown(u, { paymentMethod: "cash", amountPaid: 75 }, false)).toBe(true);
    expect(paymentLockUnknown(u, { paymentMethod: null, amountPaid: 50 }, false)).toBe(true);
    expect(paymentLockUnknown(u, { paymentMethod: null, amountPaid: null }, false)).toBe(false);
    // already known locked: shown as the real lock, not "unknown"
    expect(paymentLockUnknown(u, { paymentMethod: "cash", amountPaid: 75 }, true)).toBe(false);
    // locks loaded fine: nothing unknown
    expect(paymentLockUnknown(NO_UNKNOWN_FINANCE, { paymentMethod: "cash", amountPaid: 75 }, false)).toBe(false);
  });

  it("lists unknown items in display order", () => {
    expect(unknownFinanceItems({ ...NO_UNKNOWN_FINANCE, rates: true, coverage: true, participants: true })).toEqual([
      "participants",
      "coverage",
      "rates",
    ]);
  });
});
