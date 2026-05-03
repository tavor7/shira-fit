import { Stack } from "expo-router";
import ManagerActivityLogScreen from "../../../src/screens/ManagerActivityLogScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerActivityLogRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerActivityLog") }} />
      <ManagerActivityLogScreen />
    </>
  );
}
