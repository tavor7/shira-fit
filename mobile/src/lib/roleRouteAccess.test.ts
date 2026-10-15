import { canRoleAccessAppPath, isCoachSessionConfigPath } from "./roleRouteAccess";

describe("coach session configuration routes are manager-only", () => {
  it.each(["/coach/create-session", "/(app)/coach/create-session", "/coach/session/manage/abc", "/(app)/coach/session/manage/abc/"])(
    "coach is denied %s",
    (p) => {
      expect(isCoachSessionConfigPath(p)).toBe(true);
      expect(canRoleAccessAppPath("coach", p)).toBe(false);
    }
  );

  it.each(["/coach/sessions", "/coach/session/abc", "/coach/participant-history", "/coach/pricing", "/staff/users"])(
    "coach keeps %s",
    (p) => {
      expect(isCoachSessionConfigPath(p)).toBe(false);
      expect(canRoleAccessAppPath("coach", p)).toBe(true);
    }
  );

  it("managers keep their own session screens and athletes stay out", () => {
    expect(canRoleAccessAppPath("manager", "/manager/session/abc")).toBe(true);
    expect(canRoleAccessAppPath("manager", "/manager/create-session")).toBe(true);
    expect(canRoleAccessAppPath("athlete", "/coach/create-session")).toBe(false);
  });
});
