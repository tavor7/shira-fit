import { Stack } from "expo-router";
import ManagerSubscriptionSettingsScreen from "../../../src/screens/ManagerSubscriptionSettingsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerSubscriptionSettingsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.subscriptionSettings") }} />
      <ManagerSubscriptionSettingsScreen />
    </>
  );
}
