import {
  NO_UNKNOWN_FINANCE,
  anyFinanceUnknown,
  coveredRowKeys,
  expectedTotalUnknown,
  paymentCoverageDecision,
  paymentLockUnknown,
  rpcLookupFailed,
  unknownFinanceItems,
  writeRecordsPayment,
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

describe("payment coverage check", () => {
  const ok = (covered: string[] = [], manual: string[] = []) => ({
    data: { ok: true, covered_user_ids: covered, covered_manual_ids: manual },
    error: null,
  });
  const first = { firstPayment: true, coveredWarningAccepted: false };

  it("a failed coverage lookup blocks the payment (server error, network drop, ok:false)", () => {
    expect(paymentCoverageDecision({ data: null, error: { message: "500" } }, "u:a", first)).toBe("blocked");
    expect(paymentCoverageDecision({ data: null, error: { message: "TypeError: Failed to fetch" } }, "u:a", first)).toBe("blocked");
    expect(paymentCoverageDecision({ data: { ok: false, error: "not_authenticated" }, error: null }, "u:a", first)).toBe("blocked");
    // even for an edit of an existing payment
    expect(paymentCoverageDecision({ data: null, error: { message: "500" } }, "u:a", { firstPayment: false, coveredWarningAccepted: true })).toBe("blocked");
  });

  it("retry success followed by normal payment: a later successful check proceeds", () => {
    expect(paymentCoverageDecision({ data: null, error: { message: "500" } }, "u:a", first)).toBe("blocked");
    expect(paymentCoverageDecision(ok(), "u:a", first)).toBe("proceed");
  });

  it("a genuinely uncovered participant proceeds normally", () => {
    expect(paymentCoverageDecision(ok(["someone-else"]), "u:a", first)).toBe("proceed");
    expect(paymentCoverageDecision(ok([], []), "m:w", first)).toBe("proceed");
  });

  it("a covered participant gets the existing covered-session warning on a first payment, once", () => {
    expect(paymentCoverageDecision(ok(["a"]), "u:a", first)).toBe("warnCovered");
    expect(paymentCoverageDecision(ok([], ["w"]), "m:w", first)).toBe("warnCovered");
    expect(paymentCoverageDecision(ok(["a"]), "u:a", { firstPayment: true, coveredWarningAccepted: true })).toBe("proceed");
    // existing rule: editing an already-recorded payment is not a fresh collection
    expect(paymentCoverageDecision(ok(["a"]), "u:a", { firstPayment: false, coveredWarningAccepted: false })).toBe("proceed");
  });

  it("coverage that changed while the screen was open is decided by the fresh check", () => {
    // loaded as not covered, now covered → warn; loaded as covered (warning accepted), now not covered → proceed
    expect(paymentCoverageDecision(ok(["a"]), "u:a", first)).toBe("warnCovered");
    expect(paymentCoverageDecision(ok([]), "u:a", { firstPayment: true, coveredWarningAccepted: true })).toBe("proceed");
  });

  it("forbidden viewers are unchanged (no coverage information by design)", () => {
    expect(paymentCoverageDecision({ data: { ok: false, error: "forbidden" }, error: null }, "u:a", first)).toBe("proceed");
  });

  it("only writes that record a payment are checked; attendance-only writes are not", () => {
    expect(writeRecordsPayment("cash", null)).toBe(true);
    expect(writeRecordsPayment(null, 70)).toBe(true);
    expect(writeRecordsPayment(null, null)).toBe(false);
    expect(writeRecordsPayment(null, 0)).toBe(false);
  });
});

describe("coveredRowKeys", () => {
  it("maps covered app and walk-in participants to roster row keys; nothing for a non-ok answer", () => {
    expect([...coveredRowKeys({ ok: true, covered_user_ids: ["a"], covered_manual_ids: ["w"] })]).toEqual(["u:a", "m:w"]);
    expect(coveredRowKeys({ ok: false, error: "forbidden" }).size).toBe(0);
    expect(coveredRowKeys(null).size).toBe(0);
  });
});
