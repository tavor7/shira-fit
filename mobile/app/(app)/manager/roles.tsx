import { Stack } from "expo-router";
import RoleManagementScreen from "../../../src/screens/RoleManagementScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerRolesRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerRoles") }} />
      <RoleManagementScreen />
    </>
  );
}
