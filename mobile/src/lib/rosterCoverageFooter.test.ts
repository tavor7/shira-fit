/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { translations } from "../i18n/translations";

const src = fs.readFileSync(path.resolve(__dirname, "../components/ParticipantAttendanceList.tsx"), "utf8");
const KEY = "managerSession.rosterSlotCoveredBySubscription";

describe("roster subscription coverage footer", () => {
  const start = src.indexOf("styles.coveredFooter,");
  const footer = src.slice(start, src.indexOf(") : null}", start));

  it("renders coverage and the regular price outside the row beside the attendance controls", () => {
    expect(start).toBeGreaterThan(-1);
    expect(footer).toContain(`t("${KEY}")`);
    expect(footer).toContain('t("managerSession.rosterSlotRegularPrice")');
    const row = src.slice(src.indexOf("styles.denseRow,"), start);
    expect(row).not.toContain(`t("${KEY}")`);
    expect(row).not.toContain('t("managerSession.rosterSlotRegularPrice")');
  });

  it("never truncates the coverage text or the regular price", () => {
    expect(footer).not.toContain("numberOfLines");
  });

  it("keeps the existing covered and price conditions", () => {
    expect(src).toContain("{sessionMeta && showDueLines && effectivePrice > 0 && covered ? (\n              <View style={[styles.coveredFooter");
    expect(src).toContain("{sessionMeta && showDueLines && effectivePrice > 0 && !covered ? (");
    expect(src).toContain("const covered = isCoveredBySubscription(item);");
  });

  it("wraps and follows the language direction", () => {
    expect(src).toMatch(/coveredFooter: \{[^}]*flexWrap: "wrap"/);
    expect(src).toContain("rowFlipFor(isRTL) && styles.coveredFooterRtl");
  });

  it("keeps every detail out of the row beside the attendance controls", () => {
    const row = src.slice(src.indexOf("styles.denseRow,"), start);
    for (const part of ["styles.lockRow", "styles.paymentLine", "styles.dueLine", "styles.hiddenBadge"]) {
      expect(row).not.toContain(part);
      expect(src.indexOf(part, start)).toBeGreaterThan(start);
    }
  });

  it("wraps the row on the narrowest phones instead of squeezing the name column", () => {
    expect(src).toMatch(/denseRow: \{[^}]*flexWrap: "wrap"/);
    expect(src).toMatch(/nameBlock: \{[^}]*minWidth: 110/);
  });

  it("shows the short lock message in the card and the full explanation only on demand", () => {
    expect(translations.en["attendance.paymentLockedReceiptShort"]).toBe("Payment locked — receipt issued.");
    expect(translations.he["attendance.paymentLockedReceiptShort"]).toBe("התשלום נעול — הופקה קבלה.");
    const lockRow = src.slice(src.indexOf("styles.lockRow,"), src.indexOf("styles.lockRow,") + 1100);
    const inCard = lockRow.slice(0, lockRow.indexOf("<Pressable"));
    expect(inCard).toContain("attendance.paymentLockedReceiptShort");
    expect(inCard).not.toContain('"attendance.paymentLockedReceipt"');
    expect(lockRow).toContain("showOk(");
    expect(lockRow).toContain('"attendance.paymentLockedReceipt"');
    for (const lang of ["en", "he"] as const) {
      for (const key of ["attendance.paymentLockUnknownShort", "attendance.paymentLockDetailsTitle", "attendance.paymentLockDetailsA11y"]) {
        expect(translations[lang][key]).toBeTruthy();
      }
    }
  });

  it("has the label in both languages", () => {
    expect(translations.en[KEY]).toBe("Subscription covered");
    expect(translations.he[KEY]).toBe("מכוסה במנוי");
  });
});
