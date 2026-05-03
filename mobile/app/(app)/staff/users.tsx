import { Stack } from "expo-router";
import StaffUsersScreen from "../../../src/screens/StaffUsersScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function StaffUsersRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.staffUsers") }} />
      <StaffUsersScreen />
    </>
  );
}
