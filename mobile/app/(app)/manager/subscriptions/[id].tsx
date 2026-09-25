import { Stack } from "expo-router";
import { ManagerSubscriptionDetailScreen } from "../../../../src/screens/ManagerSubscriptionDetailScreen";
import { useI18n } from "../../../../src/context/I18nContext";

export default function ManagerSubscriptionDetailRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("subscriptions.detail.title") }} />
      <ManagerSubscriptionDetailScreen />
    </>
  );
}
