import { bulkIssueStep, bulkPredatingWarningMessage } from "./bulkReceiptWarning";
import { translations } from "../i18n/translations";

describe("bulk receipt warning for payments older than issued receipts", () => {
  it("is not shown when no selected payment predates an issued receipt", () => {
    expect(bulkPredatingWarningMessage("{n} {number}", { predating_count: 0, latest_issued_number: "001428" })).toBeNull();
  });

  it("names how many payments and which receipt, in both languages", () => {
    for (const lang of ["en", "he"] as const) {
      const template = translations[lang]["ui.pendingReceipts.predatingWarningMessage"];
      const msg = bulkPredatingWarningMessage(template, { predating_count: 45, latest_issued_number: "001428" });
      expect(msg).toContain("45");
      expect(msg).toContain("001428");
      expect(msg).not.toMatch(/\{n\}|\{number\}/);
      expect(translations[lang]["ui.pendingReceipts.predatingWarningTitle"]).toBeTruthy();
      expect(translations[lang]["ui.pendingReceipts.issueAnyway"]).toBeTruthy();
    }
  });
});

describe("what happens after the pre-issue check", () => {
  const template = translations.he["ui.pendingReceipts.predatingWarningMessage"];

  it("issues straight away when no selected payment is older than an issued receipt", () => {
    expect(bulkIssueStep(template, { ok: true, preview: { predating_count: 0, latest_issued_number: "001428" } })).toEqual({ kind: "issue" });
  });

  it("asks to confirm older payments, which stay issuable", () => {
    const step = bulkIssueStep(template, { ok: true, preview: { predating_count: 3, latest_issued_number: "001428" } });
    expect(step.kind).toBe("confirm");
    expect(step.kind === "confirm" && step.message).toContain("001428");
  });

  it("issues nothing when the check itself fails, with a Hebrew error that says so", () => {
    expect(bulkIssueStep(template, { ok: false })).toEqual({ kind: "blocked" });
    expect(translations.he["ui.pendingReceipts.preIssueCheckFailed"]).toMatch(/לא הופקו קבלות/);
    expect(translations.en["ui.pendingReceipts.preIssueCheckFailed"]).toMatch(/No receipts were issued/);
  });
});
