import type { ShowAppAlertOptions } from "../context/AppAlertContext";
import type { ExistingParticipantMatch } from "./findExistingParticipant";

export function promptAddExistingParticipant(
  showAlert: (opts: ShowAppAlertOptions) => void,
  t: (key: string) => string,
  match: ExistingParticipantMatch
): Promise<boolean> {
  const reason =
    match.matchedBy === "phone"
      ? t("quickAdd.alreadyExistsMatchPhone")
      : t("quickAdd.alreadyExistsMatchName");
  const message = t("quickAdd.alreadyExistsMessage")
    .replace("{name}", match.fullName)
    .replace("{phone}", match.phone || "—")
    .replace("{reason}", reason);

  return new Promise((resolve) => {
    showAlert({
      title: t("quickAdd.alreadyExistsTitle"),
      message,
      actions: [
        { label: t("common.cancel"), variant: "secondary", onPress: () => resolve(false) },
        { label: t("quickAdd.addExisting"), variant: "primary", onPress: () => resolve(true) },
      ],
    });
  });
}
