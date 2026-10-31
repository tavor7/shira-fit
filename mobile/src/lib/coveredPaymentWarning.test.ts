import { shouldWarnBeforeRecordingCoveredPayment } from "./coveredPaymentWarning";

describe("shouldWarnBeforeRecordingCoveredPayment", () => {
  it("warns for a covered row with no payment recorded yet", () => {
    expect(shouldWarnBeforeRecordingCoveredPayment(true, null)).toBe(true);
  });

  it("does not warn for a covered row that already has a recorded payment (viewing/correcting it)", () => {
    expect(shouldWarnBeforeRecordingCoveredPayment(true, 50)).toBe(false);
  });

  it("does not warn for an uncovered row regardless of recorded payment", () => {
    expect(shouldWarnBeforeRecordingCoveredPayment(false, null)).toBe(false);
    expect(shouldWarnBeforeRecordingCoveredPayment(false, 50)).toBe(false);
  });

  it("treats a recorded zero payment the same as any other recorded payment (no warning)", () => {
    expect(shouldWarnBeforeRecordingCoveredPayment(true, 0)).toBe(false);
  });
});
