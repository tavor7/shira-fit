import { Stack } from "expo-router";
import ManagerBackupManagementScreen from "../../../src/screens/ManagerBackupManagementScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerBackupManagementRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerBackupManagement") }} />
      <ManagerBackupManagementScreen />
    </>
  );
}
