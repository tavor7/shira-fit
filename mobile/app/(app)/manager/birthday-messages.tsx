import { Stack } from "expo-router";
import BirthdayMessagesScreen from "../../../src/screens/BirthdayMessagesScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerBirthdayMessagesRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerBirthdayMessages") }} />
      <BirthdayMessagesScreen />
    </>
  );
}
