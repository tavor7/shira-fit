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

  it("has the label in both languages", () => {
    expect(translations.en[KEY]).toBe("Subscription covered");
    expect(translations.he[KEY]).toBe("מכוסה במנוי");
  });
});
