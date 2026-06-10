import { Stack } from "expo-router";
import AccountPaymentsScreen from "../../../src/screens/AccountPaymentsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerAccountPaymentsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("menu.accountPayments") }} />
      <AccountPaymentsScreen />
    </>
  );
}
