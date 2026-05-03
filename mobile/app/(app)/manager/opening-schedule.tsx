import { Stack } from "expo-router";
import RegistrationOpeningScheduleScreen from "../../../src/screens/RegistrationOpeningScheduleScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerOpeningScheduleRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerOpeningSchedule") }} />
      <RegistrationOpeningScheduleScreen />
    </>
  );
}
