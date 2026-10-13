import { Stack } from "expo-router";
import ManagerSystemIssueDetailScreen from "../../../../src/screens/ManagerSystemIssueDetailScreen";
import { useI18n } from "../../../../src/context/I18nContext";

export default function ManagerSystemIssueDetailRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.systemIssueDetail") }} />
      <ManagerSystemIssueDetailScreen />
    </>
  );
}
