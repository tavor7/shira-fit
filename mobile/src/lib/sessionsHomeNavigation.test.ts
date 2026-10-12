import * as fs from "fs";
import * as path from "path";
import {
  appStackRouteName,
  getManagerParentHref,
  isManagerOverviewFlatTool,
  isStudioSetupItem,
  MANAGER_OVERVIEW_HREF,
  MANAGER_SETUP_HREF,
  navigateToParent,
  STAFF_USERS_HREF,
  STUDIO_SETUP_ITEM_PATHS,
} from "./sessionsHomeNavigation";

const PHONE = { setupIndexAvailable: true };
const WIDE = { setupIndexAvailable: false };

describe("getManagerParentHref (Overview → Setup → Setup item)", () => {
  it.each(STUDIO_SETUP_ITEM_PATHS)("setup item %s goes back to Setup on phones", (p) => {
    expect(getManagerParentHref(p, PHONE)).toBe(MANAGER_SETUP_HREF);
  });

  it.each(STUDIO_SETUP_ITEM_PATHS)("setup item %s goes back to Overview on wide screens (Setup is the tab strip there)", (p) => {
    expect(getManagerParentHref(p, WIDE)).toBe(MANAGER_OVERVIEW_HREF);
  });

  it("a Setup item's sub-page goes back to that item (Legal → Subscription terms)", () => {
    expect(getManagerParentHref("/manager/subscription-terms", PHONE)).toBe("/(app)/manager/legal-settings");
    expect(getManagerParentHref("/manager/subscription-terms", WIDE)).toBe("/(app)/manager/legal-settings");
  });

  it("Setup itself goes back to Overview", () => {
    expect(getManagerParentHref("/manager/setup", PHONE)).toBe(MANAGER_OVERVIEW_HREF);
    expect(getManagerParentHref("/manager/setup", WIDE)).toBe(MANAGER_OVERVIEW_HREF);
  });

  it("staff detail screens fall back to the Users list", () => {
    expect(getManagerParentHref("/staff/profile/abc", PHONE)).toBe(STAFF_USERS_HREF);
    expect(getManagerParentHref("/staff/manual/abc", WIDE)).toBe(STAFF_USERS_HREF);
  });

  it("overview flat tools still go back to Overview", () => {
    for (const p of ["/manager/activity-log", "/manager/account-payments", "/manager/documents-invoices", "/manager/pricing"]) {
      expect(getManagerParentHref(p, PHONE)).toBe(MANAGER_OVERVIEW_HREF);
    }
  });

  it("setup items are no longer flat tools (the root cause: they skipped Setup and replaced to Overview)", () => {
    for (const p of STUDIO_SETUP_ITEM_PATHS) expect(isManagerOverviewFlatTool(p)).toBe(false);
  });

  it("leaves screens outside the manager hub alone", () => {
    for (const p of ["/manager/sessions", "/manager/session/1", "/manager/dashboard", "/athlete/sessions", "/manager/subscriptions"]) {
      expect(getManagerParentHref(p, PHONE)).toBeNull();
    }
    expect(isStudioSetupItem("/manager/families/extra")).toBe(false);
  });
});

describe("STUDIO_SETUP_ITEM_PATHS stays in sync with the Setup menu (useStudioSetupItems)", () => {
  it("lists exactly the hrefs the Setup index and tab strip open", () => {
    const src = fs.readFileSync(path.join(__dirname, "../components/ManagerOverviewTabs.tsx"), "utf8");
    const block = src.slice(src.indexOf("export function useStudioSetupItems"), src.indexOf("export function ManagerStudioSetupTabs"));
    const hrefs = [...block.matchAll(/href: "\/\(app\)(\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect([...hrefs].sort()).toEqual([...STUDIO_SETUP_ITEM_PATHS].sort());
  });
});

describe("navigateToParent", () => {
  function nav(routes: string[], canGoBack = routes.length > 1) {
    const calls: string[] = [];
    return {
      calls,
      canGoBack: () => canGoBack,
      goBack: () => calls.push("goBack"),
      getState: () => ({ index: routes.length - 1, routes: routes.map((name) => ({ name })) }),
    };
  }

  it("pops when the previous entry is the parent (Overview → Setup → item)", () => {
    const n = nav(["manager/dashboard", "manager/setup", "manager/families"]);
    const replaced: string[] = [];
    expect(navigateToParent(MANAGER_SETUP_HREF, n, (h) => replaced.push(String(h)))).toBe("pop");
    expect(n.calls).toEqual(["goBack"]);
    expect(replaced).toEqual([]);
  });

  it("replaces with the parent after a deep link / refresh (no history)", () => {
    const n = nav(["manager/legal-settings"], false);
    const replaced: string[] = [];
    expect(navigateToParent(MANAGER_SETUP_HREF, n, (h) => replaced.push(String(h)))).toBe("replace");
    expect(n.calls).toEqual([]);
    expect(replaced).toEqual([MANAGER_SETUP_HREF]);
  });

  it("replaces when the previous entry is some other screen (never pops to an unrelated page)", () => {
    const n = nav(["manager/sessions", "manager/families"]);
    const replaced: string[] = [];
    expect(navigateToParent(MANAGER_SETUP_HREF, n, (h) => replaced.push(String(h)))).toBe("replace");
    expect(replaced).toEqual([MANAGER_SETUP_HREF]);
  });

  it("Setup → Overview pops when Setup was opened from Overview", () => {
    const n = nav(["manager/dashboard", "manager/setup"]);
    expect(navigateToParent(MANAGER_OVERVIEW_HREF, n, () => undefined)).toBe("pop");
  });

  it("maps app-group hrefs to stack route names", () => {
    expect(appStackRouteName(MANAGER_SETUP_HREF)).toBe("manager/setup");
    expect(appStackRouteName(STAFF_USERS_HREF)).toBe("staff/users");
  });
});
