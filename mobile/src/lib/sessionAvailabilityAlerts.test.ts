/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { translations } from "../i18n/translations";
import { classifyRpcOutcome } from "./rpcOutcomes/classify";

jest.mock("./supabase", () => ({ supabase: {} }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { availabilityAlertAction } = require("./sessionAvailabilityAlerts") as typeof import("./sessionAvailabilityAlerts");

const base = {
  enabled: true,
  subscribed: false,
  maxParticipants: 12,
  full: true,
  registered: false,
  registrationOpen: true,
  sessionNotStarted: true,
};

describe("availabilityAlertAction", () => {
  it("offers subscribing on a full group session", () => {
    expect(availabilityAlertAction(base)).toBe("subscribe");
  });
  it("covers capacity 7 and not capacity 6", () => {
    expect(availabilityAlertAction({ ...base, maxParticipants: 7 })).toBe("subscribe");
    expect(availabilityAlertAction({ ...base, maxParticipants: 6 })).toBeNull();
  });
  it.each([
    ["the feature is off", { enabled: false }],
    ["the session has space", { full: false }],
    ["registration is closed", { registrationOpen: false }],
    ["the session has started", { sessionNotStarted: false }],
    ["the athlete is registered", { registered: true }],
  ])("offers nothing when %s", (_label, change) => {
    expect(availabilityAlertAction({ ...base, ...change })).toBeNull();
  });
  it("always lets a subscribed athlete stop, even if the feature was turned off or the session has space", () => {
    expect(availabilityAlertAction({ ...base, subscribed: true })).toBe("unsubscribe");
    expect(availabilityAlertAction({ ...base, subscribed: true, enabled: false, full: false })).toBe("unsubscribe");
  });
  it("offers nothing to someone registered, even if a subscription row lingers", () => {
    expect(availabilityAlertAction({ ...base, subscribed: true, registered: true })).toBeNull();
  });
});

describe("availability alert copy", () => {
  it("says in both languages that nothing is reserved and registration is first come, first served", () => {
    expect(translations.en["athleteSession.availabilityHint"]).toMatch(/first come, first served/i);
    expect(translations.en["athleteSession.availabilityHint"]).toMatch(/reserve/i);
    expect(translations.he["athleteSession.availabilityHint"]).toContain("סדר הגעה");
    expect(translations.he["athleteSession.availabilityHint"]).toContain("לא שומרת מקום");
  });
  it("has every string in both languages", () => {
    for (const key of [
      "athleteSession.availabilitySubscribe",
      "athleteSession.availabilityUnsubscribe",
      "athleteSession.availabilityHint",
      "athleteSession.availabilitySubscribedToast",
      "athleteSession.availabilityUnsubscribedToast",
      "athleteSession.availabilityError",
      "homeAlerts.athleteAvailabilitySpot",
    ]) {
      expect(translations.en[key]).toBeTruthy();
      expect(translations.he[key]).toBeTruthy();
    }
  });
});

describe("availability alert wiring", () => {
  it("classifies every refusal the subscribe RPC can return", () => {
    for (const code of ["feature_disabled", "not_group_session", "registration_closed", "not_full", "already_registered"]) {
      expect(classifyRpcOutcome("subscribe_session_availability", code).class).toBe("business");
    }
    for (const code of ["account_disabled", "not_approved_athlete"]) {
      expect(classifyRpcOutcome("subscribe_session_availability", code).class).toBe("authorization_validation");
    }
  });
  it("keeps the alert separate from joining the waitlist on the session screen", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/(app)/athlete/session/[id].tsx"), "utf8");
    expect(src).toContain('rpc("request_waitlist"');
    expect(src).toContain("setAvailabilityAlert(");
    expect(src.indexOf("setAvailabilityAlert(")).not.toBe(src.indexOf('rpc("request_waitlist"'));
  });
});
