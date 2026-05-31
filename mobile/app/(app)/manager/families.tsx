import { Stack } from "expo-router";
import FamilyManagementScreen from "../../../src/screens/FamilyManagementScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerFamiliesRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("menu.families") }} />
      <FamilyManagementScreen />
    </>
  );
}
