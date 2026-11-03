/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../../supabase/functions/notify-waitlist/index.ts"), "utf8");
const webPush = fs.readFileSync(path.resolve(__dirname, "../../../supabase/functions/_shared/webPush.ts"), "utf8");

describe("notify-waitlist eligibility", () => {
  it("asks the database whether the session may be announced before anything is sent", () => {
    const check = src.indexOf('rpc("_waitlist_notify_skip_reason"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("exp.host"));
    expect(check).toBeLessThan(src.indexOf("sendWebPushToUser(\n"));
  });

  it("sends nothing when the check itself fails", () => {
    const failed = src.slice(src.indexOf("if (skipError) {"), src.indexOf("if (skipReason)"));
    expect(failed).toContain("return new Response");
    expect(failed).toContain('"eligibility_check_failed"');
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

describe("web push delivery log", () => {
  it("records a pruned subscription before deleting it, because the log row references it", () => {
    const logged = webPush.indexOf('outcome: "pruned"');
    expect(logged).toBeGreaterThan(-1);
    expect(logged).toBeLessThan(webPush.indexOf('.from("web_push_subscriptions").delete()'));
  });

  it("reports a log write that the database refused", () => {
    expect(webPush).toContain("const { error } = await adminClient.from(\"web_push_delivery_log\")");
    expect(webPush).toContain("insert failed: ${error.message}");
  });
});
