import { approvalStatusLabel, genderLabel, roleLabel } from "./displayLabels";
import { translations } from "../i18n/translations";

const tFor = (lang: "he" | "en") => (key: string) => (translations[lang] as Record<string, string>)[key] ?? key;

describe("display labels for stored enum values", () => {
  it("translates roles, approval statuses and gender in both languages", () => {
    for (const lang of ["he", "en"] as const) {
      const t = tFor(lang);
      for (const v of ["athlete", "coach", "manager"]) expect(roleLabel(v, t)).not.toBe(v);
      for (const v of ["pending", "approved", "rejected"]) expect(approvalStatusLabel(v, t)).not.toBe(v);
      for (const v of ["male", "female"]) expect(genderLabel(v, t)).not.toBe(v);
    }
    expect(roleLabel("athlete", tFor("he"))).toBe("מתאמן");
  });

  it("falls back to the stored value for unknown values and empties", () => {
    const t = tFor("en");
    expect(roleLabel("owner", t)).toBe("owner");
    expect(approvalStatusLabel(undefined, t)).toBe("");
  });
});
