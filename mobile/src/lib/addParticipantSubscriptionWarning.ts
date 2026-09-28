import type { ShowAppAlertOptions } from "../context/AppAlertContext";
import type { SubscriptionLimitReason } from "./subscriptionLimitConsent";

/** Staff-facing message for the subscription_limit_exceeded warning shown from
 * AddParticipantToSessionModal, phrased about the ATHLETE BEING ADDED (distinct from the
 * athlete-facing wording in athleteRegisterSessionError.ts, and from moveParticipantErrors.ts's
 * "moving" copy — this is specifically "adding"). Only ever displays a reason the backend actually
 * returned; never infers which reason applies. Mirrors moveParticipantErrorDetail's exact
 * subscription_limit_exceeded switch shape (the established reference pattern for this warning). */
export function addParticipantSubscriptionLimitMessage(reason: SubscriptionLimitReason, t: (key: string) => string): string {
  switch (reason) {
    case "frozen":
      return t("addParticipant.subscriptionFrozen");
    case "tier_not_included":
      return t("addParticipant.subscriptionTierNotIncluded");
    case "allowance_exceeded":
      return t("addParticipant.subscriptionAllowanceExceeded");
    default:
      return t("addParticipant.subscriptionGeneric");
  }
}

/** Promise-based confirm prompt, matching promptAddExistingParticipant.ts's shape (raw showAlert,
 * resolves true=proceed/false=cancel) — the same primitive AddParticipantToSessionModal already
 * uses elsewhere in the same component, not a new dialog mechanism. */
export function promptAddParticipantAcceptExtraSubscriptionCharge(
  showAlert: (opts: ShowAppAlertOptions) => void,
  t: (key: string) => string,
  reason: SubscriptionLimitReason
): Promise<boolean> {
  return new Promise((resolve) => {
    showAlert({
      title: t("addParticipant.subscriptionWarningTitle"),
      message: addParticipantSubscriptionLimitMessage(reason, t),
      actions: [
        { label: t("common.cancel"), variant: "secondary", onPress: () => resolve(false) },
        { label: t("addParticipant.addAnyway"), variant: "primary", onPress: () => resolve(true) },
      ],
    });
  });
}
