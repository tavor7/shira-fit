import {
  classifyLookupFailures,
  isRequiredLookup,
  lookupFailures,
  reportStateAfterLoad,
  type ParticipantHistoryLookup,
} from "./participantHistoryLoad";

const REQUIRED: ParticipantHistoryLookup[] = [
  "family",
  "history",
  "globalTiers",
  "payments",
  "athleteTiers",
  "subscriptionCharges",
  "coverage",
  "sessionPrices",
  "rosterPrices",
];
const DETAILS: ParticipantHistoryLookup[] = ["receipts", "staffNames", "hiddenKeys"];

describe("participantHistoryLoad", () => {
  it("treats every lookup the amounts depend on as required, and only detail lookups as optional", () => {
    for (const l of REQUIRED) expect(isRequiredLookup(l)).toBe(true);
    for (const l of DETAILS) expect(isRequiredLookup(l)).toBe(false);
  });

  it("does not count successful empty results as failures (a valid zero / empty history stays valid)", () => {
    expect(
      lookupFailures({
        history: { data: [], error: null },
        coverage: { data: [], error: null },
        subscriptionCharges: { data: null, error: null },
        family: { family: null, error: null } as never,
        hiddenKeys: null,
      })
    ).toEqual([]);
    expect(reportStateAfterLoad([], { silent: false, hasCompleteReport: false })).toEqual({ kind: "ok", missingDetails: [] });
  });

  it("collects Supabase errors (server error or network drop) and string errors", () => {
    const failures = lookupFailures({
      coverage: { data: null, error: { message: "TypeError: Failed to fetch" } },
      subscriptionCharges: { data: null, error: { message: "injected" } },
      family: { error: "get_athlete_family failed" },
      receipts: { data: [], error: null },
    });
    expect(failures).toEqual([
      { lookup: "coverage", message: "TypeError: Failed to fetch" },
      { lookup: "subscriptionCharges", message: "injected" },
      { lookup: "family", message: "get_athlete_family failed" },
    ]);
  });

  it("each required failure alone blocks the report", () => {
    for (const lookup of REQUIRED) {
      const state = reportStateAfterLoad([{ lookup, message: "x" }], { silent: false, hasCompleteReport: true });
      expect(state).toEqual({ kind: "failed", message: "x" });
    }
  });

  it("detail failures keep the report and name what is missing", () => {
    const state = reportStateAfterLoad(
      [
        { lookup: "receipts", message: "a" },
        { lookup: "staffNames", message: "b" },
        { lookup: "receipts", message: "c" },
      ],
      { silent: false, hasCompleteReport: false }
    );
    expect(state).toEqual({ kind: "ok", missingDetails: ["receipts", "staffNames"] });
  });

  it("a partial failure (required + details) blocks, with every required message", () => {
    const { blocking, missingDetails } = classifyLookupFailures([
      { lookup: "receipts", message: "r" },
      { lookup: "coverage", message: "cov" },
      { lookup: "rosterPrices", message: "rp" },
    ]);
    expect(blocking.map((f) => f.lookup)).toEqual(["coverage", "rosterPrices"]);
    expect(missingDetails).toEqual(["receipts"]);
    expect(
      reportStateAfterLoad(
        [
          { lookup: "receipts", message: "r" },
          { lookup: "coverage", message: "cov" },
          { lookup: "rosterPrices", message: "rp" },
        ],
        { silent: false, hasCompleteReport: false }
      )
    ).toEqual({ kind: "failed", message: "cov · rp" });
  });

  it("a failed background refresh keeps a complete report only marked out of date", () => {
    const f = [{ lookup: "sessionPrices" as const, message: "down" }];
    expect(reportStateAfterLoad(f, { silent: true, hasCompleteReport: true })).toEqual({ kind: "stale", message: "down" });
    // nothing trustworthy on screen → error, not "stale"
    expect(reportStateAfterLoad(f, { silent: true, hasCompleteReport: false })).toEqual({ kind: "failed", message: "down" });
    // an explicit (non-silent) load never keeps old figures
    expect(reportStateAfterLoad(f, { silent: false, hasCompleteReport: true })).toEqual({ kind: "failed", message: "down" });
  });

  it("recovery: a later load with no failures is ok again", () => {
    expect(reportStateAfterLoad([], { silent: false, hasCompleteReport: false }).kind).toBe("ok");
    expect(reportStateAfterLoad([], { silent: true, hasCompleteReport: true }).kind).toBe("ok");
  });
});
