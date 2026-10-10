import { Stack } from "expo-router";
import StudioSetupIndexScreen from "../../../src/screens/StudioSetupIndexScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerStudioSetupRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerSetup") }} />
      <StudioSetupIndexScreen />
    </>
  );
}
