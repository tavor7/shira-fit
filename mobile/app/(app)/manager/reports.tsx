import { Stack } from "expo-router";
import ManagerReportsScreen from "../../../src/screens/ManagerReportsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerReportsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerReports") }} />
      <ManagerReportsScreen />
    </>
  );
}
