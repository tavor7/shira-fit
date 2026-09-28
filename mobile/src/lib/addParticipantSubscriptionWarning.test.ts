import {
  addParticipantSubscriptionLimitMessage,
  promptAddParticipantAcceptExtraSubscriptionCharge,
} from "./addParticipantSubscriptionWarning";

const t = (key: string) => key;

describe("addParticipantSubscriptionLimitMessage", () => {
  it("maps each backend-provided reason to its own staff-facing translation key", () => {
    expect(addParticipantSubscriptionLimitMessage("frozen", t)).toBe("addParticipant.subscriptionFrozen");
    expect(addParticipantSubscriptionLimitMessage("tier_not_included", t)).toBe("addParticipant.subscriptionTierNotIncluded");
    expect(addParticipantSubscriptionLimitMessage("allowance_exceeded", t)).toBe("addParticipant.subscriptionAllowanceExceeded");
  });

  it("falls back to one safe generic message for an undefined/unrecognized reason", () => {
    expect(addParticipantSubscriptionLimitMessage(undefined, t)).toBe("addParticipant.subscriptionGeneric");
    expect(addParticipantSubscriptionLimitMessage("something_new", t)).toBe("addParticipant.subscriptionGeneric");
  });

  it("uses distinct keys from the athlete-facing message (staff vs athlete copy must differ)", () => {
    expect(addParticipantSubscriptionLimitMessage("frozen", t)).not.toBe("athleteSession.subscriptionFrozen");
  });
});

describe("promptAddParticipantAcceptExtraSubscriptionCharge", () => {
  it("resolves false on cancel, true on confirm", async () => {
    const actions: { label: string; variant: string; onPress: () => void }[] = [];
    const showAlert = (opts: { actions: typeof actions }) => {
      actions.push(...opts.actions);
    };

    const cancelPromise = promptAddParticipantAcceptExtraSubscriptionCharge(showAlert, t, "allowance_exceeded");
    actions.find((a) => a.variant === "secondary")?.onPress();
    await expect(cancelPromise).resolves.toBe(false);

    actions.length = 0;
    const confirmPromise = promptAddParticipantAcceptExtraSubscriptionCharge(showAlert, t, "tier_not_included");
    actions.find((a) => a.variant === "primary")?.onPress();
    await expect(confirmPromise).resolves.toBe(true);
  });
});
