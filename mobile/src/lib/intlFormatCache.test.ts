import fs from "node:fs";
import path from "node:path";
import { displayMoney } from "./displayFormat";

// Performance Phase 5: the date / money helpers now reuse Intl formatters instead of calling toLocale*String with
// options on every call. These tests pin that the output is identical for every options object the helpers use.

const src = fs.readFileSync(path.join(__dirname, "dateFormat.ts"), "utf8");
const optionLiterals = [...src.matchAll(/fmtDate\([a-zA-Z_]+, [^,]+, (\{[\s\S]*?\})\)/g)].map((m) => m[1]);
// eslint-disable-next-line no-new-func
const optionSets = [...new Set(optionLiterals)].map((lit) => new Function(`return (${lit});`)() as Intl.DateTimeFormatOptions);

const days: Date[] = [];
for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86_400_000) {
  const u = new Date(t);
  days.push(new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12, 0, 0));
  days.push(new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 0, 30, 0));
}

describe("cached Intl formatters are output-identical", () => {
  it("covers every options object used by dateFormat.ts", () => {
    expect(optionSets.length).toBeGreaterThanOrEqual(9);
  });

  for (const locale of ["en-GB", "he-IL"]) {
    it(`date options, ${locale}`, () => {
      for (const o of optionSets) {
        const f = new Intl.DateTimeFormat(locale, o);
        const hasTime = "hour" in o || "minute" in o;
        for (const d of days) {
          const expected = hasTime ? d.toLocaleString(locale, o) : d.toLocaleDateString(locale, o);
          expect(f.format(d)).toBe(expected);
        }
      }
    });
  }

  it("displayMoney matches toLocaleString formatting", () => {
    const reference = (amount: number) => {
      const cents = Math.round(Math.abs(amount) * 100);
      const whole = cents % 100 === 0;
      const body = (cents / 100).toLocaleString("en-US", {
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      });
      return `${amount < 0 && cents !== 0 ? "-" : ""}₪${body}`;
    };
    const strip = (s: string) => s.replace(/[⁦-⁩⁠]/g, "");
    for (let a = -2_000; a <= 25_000; a += 0.37) {
      expect(strip(displayMoney(a))).toBe(reference(a));
    }
    for (const a of [0, -0, 0.004, 0.005, 1234567.891, -99999.99, 480, 480.5, 1250.5]) {
      expect(strip(displayMoney(a))).toBe(reference(a));
    }
  });
});
