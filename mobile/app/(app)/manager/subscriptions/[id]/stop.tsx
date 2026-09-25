import { Stack, useLocalSearchParams } from "expo-router";
import { StopSubscriptionForm } from "../../../../../src/components/subscriptions/StopSubscriptionForm";
import { useI18n } from "../../../../../src/context/I18nContext";

export default function ManagerStopSubscriptionRoute() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: t("subscriptions.stop.title"), animation: "slide_from_bottom" }} />
      <StopSubscriptionForm subscriptionId={String(id)} />
    </>
  );
}
