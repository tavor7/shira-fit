import { Stack } from "expo-router";
import StaffSearchScreen from "../../../src/screens/StaffSearchScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function StaffSearchRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.staffSearch") }} />
      <StaffSearchScreen />
    </>
  );
}
