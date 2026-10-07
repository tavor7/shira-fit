/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { translations } from "../i18n/translations";

const KEY = "athleteSession.waitlistSessionStarted";

describe("waitlist session_started message", () => {
  it("has a localized message in English and Hebrew (not the raw code)", () => {
    expect(translations.en[KEY]).toBe("The session has already started, so you can no longer join the waitlist.");
    expect(translations.he[KEY]).toBe("האימון כבר התחיל ולא ניתן להצטרף לרשימת ההמתנה.");
    for (const lang of ["en", "he"] as const) expect(translations[lang][KEY]).not.toMatch(/session_started/);
  });

  it("every athlete-side request_waitlist caller maps session_started to that message", () => {
    const root = path.resolve(__dirname, "../..");
    const callers = [
      "src/components/AthleteNextSessionHero.tsx",
      "app/(app)/athlete/sessions.tsx",
      "app/(app)/athlete/session/[id].tsx",
    ];
    for (const f of callers) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src).toContain('rpc("request_waitlist"');
      expect(src).toContain('=== "session_started"');
      expect(src).toContain(`t("${KEY}")`);
    }
    // no other file calls request_waitlist from the app
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !p.includes("rpcOutcomes") && fs.readFileSync(p, "utf8").includes('"request_waitlist"')) {
          found.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "app"));
    expect(found.sort()).toEqual([...callers].sort());
  });
});
