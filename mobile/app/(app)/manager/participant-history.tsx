import { Stack } from "expo-router";
import ParticipantHistoryScreen from "../../../src/screens/ParticipantHistoryScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerParticipantHistoryRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerParticipantHistory") }} />
      <ParticipantHistoryScreen />
    </>
  );
}
