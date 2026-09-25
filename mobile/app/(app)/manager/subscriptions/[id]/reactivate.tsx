import { Stack, useLocalSearchParams } from "expo-router";
import { ReactivateSubscriptionForm } from "../../../../../src/components/subscriptions/ReactivateSubscriptionForm";
import { useI18n } from "../../../../../src/context/I18nContext";

export default function ManagerReactivateSubscriptionRoute() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: t("subscriptions.reactivate.title"), animation: "slide_from_bottom" }} />
      <ReactivateSubscriptionForm sourceSubscriptionId={String(id)} />
    </>
  );
}
