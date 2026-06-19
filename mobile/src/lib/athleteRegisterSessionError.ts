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
