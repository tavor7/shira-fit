import { bulkPredatingWarningMessage } from "./bulkReceiptWarning";
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
