/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../../supabase/functions/notify-waitlist/index.ts"), "utf8");

describe("notify-waitlist eligibility", () => {
  it("asks the database whether the session may be announced before anything is sent", () => {
    const check = src.indexOf('rpc("_waitlist_notify_skip_reason"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("exp.host"));
    expect(check).toBeLessThan(src.indexOf("sendWebPushToUser(\n"));
  });

  it("sends to the first eligible person, not simply the first waitlist row", () => {
    expect(src).toContain('rpc("_waitlist_first_eligible_user"');
    expect(src).not.toContain('.from("waitlist_requests")');
  });

  it("does not change the waitlist or the registration", () => {
    expect(src).not.toMatch(/\.(delete|insert|update|upsert)\(/);
    expect(src).not.toContain("session_registrations\").update");
  });

  it("labels the push for the delivery log", () => {
    expect(src).toContain('"waitlist_spot"');
  });
});
