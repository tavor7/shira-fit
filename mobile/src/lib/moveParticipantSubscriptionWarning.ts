import type { ShowAppAlertOptions } from "../context/AppAlertContext";
import type { SubscriptionLimitReason } from "./subscriptionLimitConsent";
import { moveParticipantErrorDetail } from "./moveParticipantErrors";

/** Promise-based confirm prompt for the subscription_limit_exceeded warning shown from
 * MoveParticipantSheet, matching promptAddParticipantAcceptExtraSubscriptionCharge.ts's shape
 * (raw showAlert, resolves true=proceed/false=cancel). Reuses moveParticipantErrorDetail's
 * existing reason-switch copy for the message body instead of duplicating it. */
export function promptMoveParticipantAcceptExtraSubscriptionCharge(
  showAlert: (opts: ShowAppAlertOptions) => void,
  t: (key: string) => string,
  reason: SubscriptionLimitReason
): Promise<boolean> {
  return new Promise((resolve) => {
    showAlert({
      title: t("moveParticipant.subscriptionWarningTitle"),
      message: moveParticipantErrorDetail("subscription_limit_exceeded", t, reason),
      actions: [
        { label: t("common.cancel"), variant: "secondary", onPress: () => resolve(false) },
        { label: t("moveParticipant.moveAnyway"), variant: "primary", onPress: () => resolve(true) },
      ],
    });
  });
}
