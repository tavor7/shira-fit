/**
 * Session Detail's covered-session duplicate-collection guard (ParticipantAttendanceList). A row
 * whose registration/manual participation was already decided covered=true by the subscription
 * coverage engine (subscription_registration_coverage, surfaced via session_subscription_coverage)
 * should normally have nothing to collect -- warn before opening the payment modal so a manager
 * doesn't accidentally double-collect. Only warn when about to record a FIRST payment: once a
 * payment already exists on the row (existingAmountPaid != null), opening the modal again is
 * viewing/correcting that record, not a fresh collection, so no warning is needed. Confirming the
 * warning still lets a manager record a genuine supplemental charge exactly as before -- this
 * function only decides whether to ask, never whether to allow.
 */
export function shouldWarnBeforeRecordingCoveredPayment(
  covered: boolean,
  existingAmountPaid: number | null
): boolean {
  return covered && existingAmountPaid == null;
}
