import { Stack } from "expo-router";
import ManagerSystemIssueDetailScreen from "../../../../src/screens/ManagerSystemIssueDetailScreen";
import { useAuth } from "../../../../src/context/AuthContext";
import { useI18n } from "../../../../src/context/I18nContext";

export default function ManagerSystemIssueDetailRoute() {
  const { t } = useI18n();
  const { profile } = useAuth();
  // Never mount (and so never query) the monitoring screens for a non-manager, even for the moment before the layout guard redirects.
  const isManager = profile?.role === "manager";
  return (
    <>
      <Stack.Screen options={{ title: t("screen.systemIssueDetail") }} />
      {isManager ? <ManagerSystemIssueDetailScreen /> : null}
    </>
  );
}
