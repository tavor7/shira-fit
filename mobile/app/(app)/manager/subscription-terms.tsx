import { Stack } from "expo-router";
import ManagerSubscriptionTermsScreen from "../../../src/screens/ManagerSubscriptionTermsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerSubscriptionTermsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("managerSubscriptionTerms.title") }} />
      <ManagerSubscriptionTermsScreen />
    </>
  );
}
