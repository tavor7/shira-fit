import { Stack } from "expo-router";
import ManagerLegalSettingsScreen from "../../../src/screens/ManagerLegalSettingsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerLegalSettingsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerLegalSettings") }} />
      <ManagerLegalSettingsScreen />
    </>
  );
}
