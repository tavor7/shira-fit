import { Stack } from "expo-router";
import TrainerCalendarColorsScreen from "../../../src/screens/TrainerCalendarColorsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerTrainerColorsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerTrainerColors") }} />
      <TrainerCalendarColorsScreen />
    </>
  );
}
