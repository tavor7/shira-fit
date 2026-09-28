import { attemptWithSubscriptionConsent, isSubscriptionLimitExceeded, type RpcResult } from "./subscriptionLimitConsent";

describe("isSubscriptionLimitExceeded", () => {
  it("recognizes the structured subscription_limit_exceeded rejection", () => {
    expect(isSubscriptionLimitExceeded({ ok: false, error: "subscription_limit_exceeded", reason: "allowance_exceeded" })).toBe(true);
  });

  it("does not recognize other error codes", () => {
    expect(isSubscriptionLimitExceeded({ ok: false, error: "full" })).toBe(false);
    expect(isSubscriptionLimitExceeded({ ok: false, error: "already_registered" })).toBe(false);
  });

  it("does not recognize a successful result", () => {
    expect(isSubscriptionLimitExceeded({ ok: true })).toBe(false);
  });

  it("handles null/undefined safely", () => {
    expect(isSubscriptionLimitExceeded(null)).toBe(false);
    expect(isSubscriptionLimitExceeded(undefined)).toBe(false);
  });
});

describe("attemptWithSubscriptionConsent", () => {
  it("returns the first result unchanged when the call succeeds -- no confirm dialog is ever invoked", async () => {
    const callRpc = jest.fn(async (accept: boolean): Promise<RpcResult> => ({ ok: true, accepted: accept }));
    const confirmConsent = jest.fn(async () => true);

    const result = await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(result).toEqual({ ok: true, accepted: false });
    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(callRpc).toHaveBeenCalledWith(false);
    expect(confirmConsent).not.toHaveBeenCalled();
  });

  it("treats an unrelated error as a normal error, never invoking the consent dialog and never retrying", async () => {
    const callRpc = jest.fn(async (): Promise<RpcResult> => ({ ok: false, error: "already_registered" }));
    const confirmConsent = jest.fn(async () => true);

    const result = await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(result).toEqual({ ok: false, error: "already_registered" });
    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(confirmConsent).not.toHaveBeenCalled();
  });

  it("on a subscription_limit_exceeded response, shows the consent dialog with the backend's reason and does NOT retry if declined", async () => {
    const callRpc = jest.fn(async (): Promise<RpcResult> => ({ ok: false, error: "subscription_limit_exceeded", reason: "frozen" }));
    const confirmConsent = jest.fn(async () => false);

    const result = await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(confirmConsent).toHaveBeenCalledTimes(1);
    expect(confirmConsent).toHaveBeenCalledWith("frozen");
    expect(result).toEqual({ ok: false, error: "cancelled" });
    // Cancelling must never trigger a second call -- no retry, no state change.
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it("on confirm, retries exactly once with p_accept_extra_subscription_charge (true) and returns that result", async () => {
    const callRpc = jest
      .fn<Promise<RpcResult>, [boolean]>()
      .mockResolvedValueOnce({ ok: false, error: "subscription_limit_exceeded", reason: "allowance_exceeded" })
      .mockResolvedValueOnce({ ok: true });
    const confirmConsent = jest.fn(async () => true);

    const result = await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(result).toEqual({ ok: true });
    expect(callRpc).toHaveBeenCalledTimes(2);
    expect(callRpc).toHaveBeenNthCalledWith(1, false);
    expect(callRpc).toHaveBeenNthCalledWith(2, true);
  });

  it("if the retried (accepted) call itself fails, that failure is returned as-is -- no infinite loop, no third call", async () => {
    const callRpc = jest
      .fn<Promise<RpcResult>, [boolean]>()
      .mockResolvedValueOnce({ ok: false, error: "subscription_limit_exceeded", reason: "tier_not_included" })
      .mockResolvedValueOnce({ ok: false, error: "subscription_limit_exceeded", reason: "tier_not_included" });
    const confirmConsent = jest.fn(async () => true);

    const result = await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(result).toEqual({ ok: false, error: "subscription_limit_exceeded", reason: "tier_not_included" });
    expect(callRpc).toHaveBeenCalledTimes(2);
    expect(confirmConsent).toHaveBeenCalledTimes(1);
  });

  it("passes through a bare subscription_limit_exceeded with no reason (safe generic case)", async () => {
    const callRpc = jest
      .fn<Promise<RpcResult>, [boolean]>()
      .mockResolvedValueOnce({ ok: false, error: "subscription_limit_exceeded" })
      .mockResolvedValueOnce({ ok: true });
    const confirmConsent = jest.fn(async () => true);

    await attemptWithSubscriptionConsent(callRpc, confirmConsent);

    expect(confirmConsent).toHaveBeenCalledWith(undefined);
  });
});
