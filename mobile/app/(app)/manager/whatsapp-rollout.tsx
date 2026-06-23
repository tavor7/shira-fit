import { Stack } from "expo-router";
import WhatsAppRolloutScreen from "../../../src/screens/WhatsAppRolloutScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerWhatsappRolloutRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerWhatsappRollout") }} />
      <WhatsAppRolloutScreen />
    </>
  );
}
