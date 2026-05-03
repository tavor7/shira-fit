import { Stack } from "expo-router";
import ManagerCoachSessionsReportScreen from "../../../src/screens/ManagerCoachSessionsReportScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerCoachSessionsReportRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerCoachSessionsReport") }} />
      <ManagerCoachSessionsReportScreen />
    </>
  );
}
