import { Redirect } from "expo-router";

/** Deep links and old menu paths land here; notifications live under Profile. */
export default function NotificationsSettingsRedirect() {
  return <Redirect href="/(app)/profile?tab=notifications" />;
}
