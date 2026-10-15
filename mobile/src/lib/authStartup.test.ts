import { decideAuthEventAction, RESUME_PROFILE_REFRESH_MIN_MS } from "./authEvents";
import { hasSignupSyncRun, profileHasSignupGaps, resetSignupSyncForTests, runSignupSyncOnce, type SignupSyncDeps } from "./signupSync";

const base = { prevAccessToken: "t1", nextAccessToken: "t1", msSinceProfileLoad: 0 };

describe("decideAuthEventAction (Performance Phase 1 / step 2)", () => {
  it("signed out when the event carries no user", () => {
    expect(decideAuthEventAction({ ...base, event: "SIGNED_OUT", prevUserId: "u1", nextUserId: null })).toEqual({ kind: "signedOut" });
  });

  it("a real sign-in of a different user blocks the UI and loads the profile", () => {
    expect(decideAuthEventAction({ ...base, event: "SIGNED_IN", prevUserId: null, nextUserId: "u1" })).toEqual({
      kind: "userChanged",
      blockUi: true,
    });
    expect(decideAuthEventAction({ ...base, event: "SIGNED_IN", prevUserId: "u1", nextUserId: "u2" })).toEqual({
      kind: "userChanged",
      blockUi: true,
    });
  });

  it.each(["INITIAL_SESSION", "TOKEN_REFRESHED", "USER_UPDATED"])("%s for a new user loads the profile without a full-screen spinner", (event) => {
    expect(decideAuthEventAction({ ...base, event, prevUserId: null, nextUserId: "u1" })).toEqual({ kind: "userChanged", blockUi: false });
  });

  it("the INITIAL_SESSION echo after bootstrap does nothing", () => {
    expect(decideAuthEventAction({ ...base, event: "INITIAL_SESSION", prevUserId: "u1", nextUserId: "u1" })).toEqual({
      kind: "sameUser",
      updateSession: false,
      refreshProfile: false,
    });
  });

  it("a token refresh replaces the session but does not reload the profile", () => {
    expect(
      decideAuthEventAction({ ...base, event: "TOKEN_REFRESHED", prevUserId: "u1", nextUserId: "u1", nextAccessToken: "t2" })
    ).toEqual({ kind: "sameUser", updateSession: true, refreshProfile: false });
  });

  it("tab / PWA resume (same-user SIGNED_IN) refreshes only the profile row, at most every 30 s", () => {
    expect(
      decideAuthEventAction({ ...base, event: "SIGNED_IN", prevUserId: "u1", nextUserId: "u1", msSinceProfileLoad: RESUME_PROFILE_REFRESH_MIN_MS })
    ).toEqual({ kind: "sameUser", updateSession: false, refreshProfile: true });
    expect(
      decideAuthEventAction({ ...base, event: "SIGNED_IN", prevUserId: "u1", nextUserId: "u1", msSinceProfileLoad: RESUME_PROFILE_REFRESH_MIN_MS - 1 })
    ).toEqual({ kind: "sameUser", updateSession: false, refreshProfile: false });
  });

  it("USER_UPDATED for the same user refreshes the profile", () => {
    expect(decideAuthEventAction({ ...base, event: "USER_UPDATED", prevUserId: "u1", nextUserId: "u1" })).toEqual({
      kind: "sameUser",
      updateSession: false,
      refreshProfile: true,
    });
  });
});

describe("runSignupSyncOnce", () => {
  beforeEach(() => resetSignupSyncForTests());

  function deps(over: Partial<SignupSyncDeps> = {}, log: string[] = []): SignupSyncDeps {
    return {
      syncProfile: async () => {
        log.push("profile:start");
        await Promise.resolve();
        log.push("profile:end");
        return false;
      },
      syncReceiptsConsent: async () => {
        log.push("receipts:start");
        return false;
      },
      syncLegalConsents: async () => {
        log.push("legal:start");
        return 0;
      },
      ...over,
    };
  }

  it("runs the profile sync first, then both consent syncs together", async () => {
    const log: string[] = [];
    await runSignupSyncOnce("u1", deps({}, log));
    expect(log.slice(0, 2)).toEqual(["profile:start", "profile:end"]);
    expect(log.slice(2).sort()).toEqual(["legal:start", "receipts:start"]);
  });

  it("runs at most once per user per app session", async () => {
    const d = deps();
    const spy = jest.spyOn(d, "syncProfile");
    expect(hasSignupSyncRun("u1")).toBe(false);
    const nothing = { profileApplied: false, receiptsConsentRecorded: false, legalConsentsRecorded: 0 };
    expect(await runSignupSyncOnce("u1", d)).toEqual({ ran: true, ...nothing });
    expect(hasSignupSyncRun("u1")).toBe(true);
    expect(await runSignupSyncOnce("u1", d)).toEqual({ ran: false, ...nothing });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await runSignupSyncOnce("u2", d)).ran).toBe(true);
  });

  it("reports what each sync recorded", async () => {
    const res = await runSignupSyncOnce(
      "u1",
      deps({ syncProfile: async () => true, syncReceiptsConsent: async () => true, syncLegalConsents: async () => 2 })
    );
    expect(res).toEqual({ ran: true, profileApplied: true, receiptsConsentRecorded: true, legalConsentsRecorded: 2 });
  });

  it("never throws; a failing sync reports nothing recorded (the gates still prompt for what is missing)", async () => {
    const res = await runSignupSyncOnce("u1", deps({ syncReceiptsConsent: async () => { throw new Error("offline"); } }));
    expect(res).toEqual({ ran: true, profileApplied: false, receiptsConsentRecorded: false, legalConsentsRecorded: 0 });
  });
});

describe("profileHasSignupGaps", () => {
  const full = {
    full_name: "A",
    phone: "050",
    address: "St 1",
    zip_code: "123",
    gender: "female",
    date_of_birth: "2000-01-01",
    health_declaration_confirmed_at: "2026-01-01T00:00:00Z",
  };
  it("a complete profile has nothing the signup sync could fill", () => {
    expect(profileHasSignupGaps(full)).toBe(false);
  });
  it.each([
    ["full_name", ""],
    ["phone", "  "],
    ["address", ""],
    ["zip_code", null],
    ["gender", "other"],
    ["date_of_birth", null],
    ["health_declaration_confirmed_at", null],
  ])("an empty %s is a gap", (field, value) => {
    expect(profileHasSignupGaps({ ...full, [field]: value })).toBe(true);
  });
  it("an unknown profile counts as a gap", () => {
    expect(profileHasSignupGaps(null)).toBe(true);
  });
});
