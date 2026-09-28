import { athleteRegisterSessionErrorDetail, athleteSubscriptionLimitMessage, promptAcceptExtraSubscriptionCharge } from "./athleteRegisterSessionError";

const t = (key: string) => key;

describe("athleteRegisterSessionErrorDetail", () => {
  it("maps known codes to translation keys", () => {
    expect(athleteRegisterSessionErrorDetail("already_registered", t)).toBe("athleteSession.alreadyRegistered");
    expect(athleteRegisterSessionErrorDetail("full", t)).toBe("athleteSession.registerFull");
  });

  it("never leaks an unrecognized raw code to a translation key -- but does fall back to it as a last resort", () => {
    // Documents the existing fallthrough this task is specifically closing for
    // subscription_limit_exceeded: any OTHER still-unmapped code still falls through to the raw
    // code (unchanged, out of scope for this fix).
    expect(athleteRegisterSessionErrorDetail("some_future_unmapped_code", t)).toBe("some_future_unmapped_code");
  });
});

describe("athleteSubscriptionLimitMessage", () => {
  it("maps each backend-provided reason to its own translation key", () => {
    expect(athleteSubscriptionLimitMessage("frozen", t)).toBe("athleteSession.subscriptionFrozen");
    expect(athleteSubscriptionLimitMessage("tier_not_included", t)).toBe("athleteSession.subscriptionTierNotIncluded");
    expect(athleteSubscriptionLimitMessage("allowance_exceeded", t)).toBe("athleteSession.subscriptionAllowanceExceeded");
  });

  it("falls back to one safe generic message for an undefined/unrecognized reason -- never fabricates a reason", () => {
    expect(athleteSubscriptionLimitMessage(undefined, t)).toBe("athleteSession.subscriptionGeneric");
    expect(athleteSubscriptionLimitMessage("some_new_reason_backend_added_later", t)).toBe("athleteSession.subscriptionGeneric");
  });
});

describe("promptAcceptExtraSubscriptionCharge", () => {
  it("resolves false when the cancel action is pressed, without calling the confirm action", () => {
    const actions: { label: string; variant: string; onPress: () => void }[] = [];
    const showAlert = (opts: { actions: typeof actions }) => {
      actions.push(...opts.actions);
    };

    const promise = promptAcceptExtraSubscriptionCharge(showAlert, t, "allowance_exceeded");
    const cancelAction = actions.find((a) => a.variant === "secondary");
    cancelAction?.onPress();

    return expect(promise).resolves.toBe(false);
  });

  it("resolves true when the confirm (register anyway) action is pressed", () => {
    const actions: { label: string; variant: string; onPress: () => void }[] = [];
    const showAlert = (opts: { actions: typeof actions }) => {
      actions.push(...opts.actions);
    };

    const promise = promptAcceptExtraSubscriptionCharge(showAlert, t, "frozen");
    const confirmAction = actions.find((a) => a.variant === "primary");
    confirmAction?.onPress();

    return expect(promise).resolves.toBe(true);
  });
});
