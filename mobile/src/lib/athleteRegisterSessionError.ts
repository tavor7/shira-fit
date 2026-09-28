import type { ShowAppAlertOptions } from "../context/AppAlertContext";
import type { SubscriptionLimitReason } from "./subscriptionLimitConsent";

/** User-facing detail for register_for_session RPC error codes. */
export function athleteRegisterSessionErrorDetail(code: string, t: (key: string) => string): string {
  switch (code) {
    case "already_registered":
      return t("athleteSession.alreadyRegistered");
    case "full":
      return t("athleteSession.registerFull");
    case "registration_closed":
      return t("athleteSession.registerClosed");
    case "session_ended":
      return t("athleteSession.sessionEndedNoRegister");
    case "session_not_available":
      return t("athleteSession.sessionNotAvailable");
    case "account_disabled":
      return t("athleteSession.accountDisabled");
    case "not_approved_athlete":
      return t("athleteSession.notApproved");
    default:
      return code;
  }
}

/** Athlete-facing message for the subscription_limit_exceeded warning, phrased about the
 * athlete's OWN session/subscription (distinct from the staff-facing wording used when a coach or
 * manager adds someone else — see addParticipantSubscriptionWarning.ts). Only ever displays a
 * reason the backend actually returned; never infers which reason applies. */
export function athleteSubscriptionLimitMessage(reason: SubscriptionLimitReason, t: (key: string) => string): string {
  switch (reason) {
    case "frozen":
      return t("athleteSession.subscriptionFrozen");
    case "tier_not_included":
      return t("athleteSession.subscriptionTierNotIncluded");
    case "allowance_exceeded":
      return t("athleteSession.subscriptionAllowanceExceeded");
    default:
      return t("athleteSession.subscriptionGeneric");
  }
}

/** Promise-based confirm prompt for the athlete subscription-limit warning, matching
 * promptAddExistingParticipant.ts's shape (raw showAlert, resolves true=proceed/false=cancel). */
export function promptAcceptExtraSubscriptionCharge(
  showAlert: (opts: ShowAppAlertOptions) => void,
  t: (key: string) => string,
  reason: SubscriptionLimitReason
): Promise<boolean> {
  return new Promise((resolve) => {
    showAlert({
      title: t("athleteSession.subscriptionWarningTitle"),
      message: athleteSubscriptionLimitMessage(reason, t),
      actions: [
        { label: t("common.cancel"), variant: "secondary", onPress: () => resolve(false) },
        { label: t("athleteSession.registerAnyway"), variant: "primary", onPress: () => resolve(true) },
      ],
    });
  });
}
