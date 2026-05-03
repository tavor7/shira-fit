import { Stack } from "expo-router";
import ManagerDashboardScreen from "../../../src/screens/ManagerDashboardScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerDashboardRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerDashboard") }} />
      <ManagerDashboardScreen />
    </>
  );
}
