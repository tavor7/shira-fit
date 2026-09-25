import { Stack } from "expo-router";
import { ManagerSubscriptionsScreen } from "../../../src/screens/ManagerSubscriptionsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerSubscriptionsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("subscriptions.title") }} />
      <ManagerSubscriptionsScreen />
    </>
  );
}
