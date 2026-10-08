import { pluralKey } from "./pluralKey";
import { translations } from "../i18n/translations";

const tFor = (lang: "he" | "en") => (key: string) => (translations[lang] as Record<string, string>)[key] ?? key;

describe("pluralKey", () => {
  it("uses the singular template for one", () => {
    expect(pluralKey(tFor("en"), "coachReport.sessionCount", 1).replace("{n}", "1")).toBe("1 session");
    expect(pluralKey(tFor("en"), "coachReport.sessionCount", 3).replace("{n}", "3")).toBe("3 sessions");
  });

  it("falls back to the plural template when no singular exists", () => {
    const t = (k: string) => (k === "x.count" ? "{n} things" : k);
    expect(pluralKey(t, "x.count", 1)).toBe("{n} things");
  });

  it("has a singular form in both languages for every count template that defines one", () => {
    for (const lang of ["he", "en"] as const) {
      const dict = translations[lang] as Record<string, string>;
      for (const key of Object.keys(dict).filter((k) => k.endsWith("_one"))) {
        const base = key.slice(0, -4);
        expect(dict[base]).toBeDefined();
        expect((translations[lang === "he" ? "en" : "he"] as Record<string, string>)[key]).toBeDefined();
      }
    }
  });
});
