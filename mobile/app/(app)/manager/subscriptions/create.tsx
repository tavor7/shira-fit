import { Stack } from "expo-router";
import { CreateSubscriptionForm } from "../../../../src/components/subscriptions/CreateSubscriptionForm";
import { useI18n } from "../../../../src/context/I18nContext";

export default function ManagerCreateSubscriptionRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("subscriptions.create.title"), animation: "slide_from_bottom" }} />
      <CreateSubscriptionForm />
    </>
  );
}
