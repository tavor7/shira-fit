import * as fs from "fs";
import * as path from "path";
import { createLoadSequencer, showInitialSkeleton } from "./screenRefresh";

describe("showInitialSkeleton (Performance Phase 1 / step 5)", () => {
  it("shows skeletons only for a first load", () => {
    expect(showInitialSkeleton(true, false)).toBe(true);
    expect(showInitialSkeleton(true, true)).toBe(false); // background refresh keeps the content
    expect(showInitialSkeleton(false, false)).toBe(false);
    expect(showInitialSkeleton(false, true)).toBe(false);
  });
});

describe("createLoadSequencer", () => {
  it("lets only the newest load apply its result", async () => {
    const seq = createLoadSequencer();
    const applied: string[] = [];
    const load = async (label: string, ms: number) => {
      const ticket = seq.next();
      await new Promise((r) => setTimeout(r, ms));
      if (seq.isLatest(ticket)) applied.push(label);
    };
    await Promise.all([load("older, slower", 30), load("newer, faster", 5)]);
    expect(applied).toEqual(["newer, faster"]);
  });

  it("sequencers are independent per screen", () => {
    const a = createLoadSequencer();
    const b = createLoadSequencer();
    const ta = a.next();
    b.next();
    b.next();
    expect(a.isLatest(ta)).toBe(true);
  });
});

describe("screens that keep content through refreshes are scoped to the signed-in user", () => {
  const MOBILE = path.join(__dirname, "..", "..");
  const FILES = [
    "app/(app)/athlete/sessions.tsx",
    "app/(app)/athlete/my-sessions.tsx",
    "app/(app)/coach/sessions.tsx",
    "app/(app)/manager/sessions.tsx",
  ];
  it.each(FILES)("%s", (f) => {
    const code = fs.readFileSync(path.join(MOBILE, f), "utf8");
    // The default export only wraps the screen in UserScopedScreen, so another account never sees kept data.
    expect(code).toMatch(/export default function \w+\(\) \{\s*return \(\s*<UserScopedScreen>/);
    expect(code).toContain("showInitialSkeleton(loading, hasData)");
  });
});
