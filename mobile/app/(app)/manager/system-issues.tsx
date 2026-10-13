import { Stack } from "expo-router";
import ManagerSystemIssuesScreen from "../../../src/screens/ManagerSystemIssuesScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerSystemIssuesRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.systemIssues") }} />
      <ManagerSystemIssuesScreen />
    </>
  );
}
