import { Stack } from "expo-router";
import StaffEditProfileScreen from "../../../../src/screens/StaffEditProfileScreen";
import { useI18n } from "../../../../src/context/I18nContext";

export default function StaffProfileRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.staffProfile") }} />
      <StaffEditProfileScreen />
    </>
  );
}
