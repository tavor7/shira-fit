/** User-facing detail for staff_move_session_participant RPC error codes. */
export function moveParticipantErrorDetail(code: string, t: (key: string) => string): string {
  switch (code) {
    case "full":
      return t("moveParticipant.errorFull");
    case "already_in_session":
      return t("moveParticipant.errorAlreadyInSession");
    case "session_started":
      return t("moveParticipant.errorSessionStarted");
    case "same_week":
      return t("moveParticipant.errorSameWeek");
    case "same_session":
      return t("moveParticipant.errorSameSession");
    case "not_on_source":
      return t("moveParticipant.errorNotOnSource");
    case "roster_locked":
      return t("moveParticipant.errorRosterLocked");
    case "account_disabled":
      return t("moveParticipant.errorAccountDisabled");
    case "forbidden":
      return t("moveParticipant.errorForbidden");
    default:
      return code;
  }
}
