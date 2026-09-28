import { promptMoveParticipantAcceptExtraSubscriptionCharge } from "./moveParticipantSubscriptionWarning";

const t = (key: string) => key;

describe("promptMoveParticipantAcceptExtraSubscriptionCharge", () => {
  it("resolves false on cancel, true on confirm", async () => {
    const actions: { label: string; variant: string; onPress: () => void }[] = [];
    const showAlert = (opts: { actions: typeof actions }) => {
      actions.push(...opts.actions);
    };

    const cancelPromise = promptMoveParticipantAcceptExtraSubscriptionCharge(showAlert, t, "allowance_exceeded");
    actions.find((a) => a.variant === "secondary")?.onPress();
    await expect(cancelPromise).resolves.toBe(false);

    actions.length = 0;
    const confirmPromise = promptMoveParticipantAcceptExtraSubscriptionCharge(showAlert, t, "tier_not_included");
    actions.find((a) => a.variant === "primary")?.onPress();
    await expect(confirmPromise).resolves.toBe(true);
  });

  it("reuses moveParticipantErrorDetail's reason-switch copy for the message body", async () => {
    const actions: { label: string; variant: string; onPress: () => void }[] = [];
    let message = "";
    const showAlert = (opts: { message: string; actions: typeof actions }) => {
      message = opts.message;
      actions.push(...opts.actions);
    };

    void promptMoveParticipantAcceptExtraSubscriptionCharge(showAlert, t, "frozen");
    expect(message).toBe("moveParticipant.errorSubscriptionFrozen");
    actions.find((a) => a.variant === "secondary")?.onPress();
  });
});
