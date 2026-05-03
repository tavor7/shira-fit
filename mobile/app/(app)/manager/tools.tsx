import { Stack } from "expo-router";
import ManagerToolsScreen from "../../../src/screens/ManagerToolsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerToolsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerTools") }} />
      <ManagerToolsScreen />
    </>
  );
}
