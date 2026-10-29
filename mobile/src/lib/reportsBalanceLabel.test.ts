import { translations } from "../i18n/translations";

describe("Reports balance tile labels", () => {
  const keys = ["billing.balanceOwesPeriodLabel", "billing.balanceReceivedMorePeriodLabel"] as const;

  it("never embed the amount placeholder, so the amount always renders as its own short, unwrappable value instead of being concatenated into a long sentence that can get cut off", () => {
    for (const lang of ["en", "he"] as const) {
      for (const key of keys) {
        const value = translations[lang][key];
        expect(value).toBeTruthy();
        expect(value).not.toContain("{n}");
      }
    }
  });

  it("keeps each label reasonably short, since it renders inside a third-width tile alongside two other stat tiles", () => {
    for (const lang of ["en", "he"] as const) {
      for (const key of keys) {
        expect(translations[lang][key].length).toBeLessThanOrEqual(40);
      }
    }
  });
});
