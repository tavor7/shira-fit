import { appStackRouteName, isInAppStack } from "./menuNavigation";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), dismissTo: jest.fn() }, useNavigationContainerRef: jest.fn() }));

const root = (names: string[]) => ({ routes: [{ name: "(app)", state: { routes: names.map((name) => ({ name })) } }] });

describe("menuNavigation", () => {
  it("maps menu hrefs to (app) stack route names", () => {
    expect(appStackRouteName("/(app)/manager/sessions")).toBe("manager/sessions");
    expect(appStackRouteName("/(app)/staff/users")).toBe("staff/users");
  });

  it("returns to a section that is already open", () => {
    expect(isInAppStack(root(["manager/sessions", "manager/session/[id]", "manager/dashboard"]), "/(app)/manager/sessions")).toBe(true);
  });

  it("pushes a section that is not open (Back keeps working as before)", () => {
    expect(isInAppStack(root(["manager/sessions"]), "/(app)/manager/dashboard")).toBe(false);
  });

  it("never matches a detail screen by prefix", () => {
    expect(isInAppStack(root(["manager/session/[id]"]), "/(app)/manager/sessions")).toBe(false);
  });

  it("finds the (app) stack under expo-router's root route", () => {
    expect(isInAppStack({ routes: [{ name: "__root", state: root(["manager/sessions", "manager/dashboard"]) }] }, "/(app)/manager/sessions")).toBe(true);
  });

  it("pushes when the navigation state is not available yet", () => {
    expect(isInAppStack(null, "/(app)/manager/sessions")).toBe(false);
    expect(isInAppStack({ routes: [] }, "/(app)/manager/sessions")).toBe(false);
  });
});
