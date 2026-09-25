import { Platform } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { FreezeSubscriptionForm } from "../../../../../src/components/subscriptions/FreezeSubscriptionForm";
import { useI18n } from "../../../../../src/context/I18nContext";

export default function ManagerFreezeSubscriptionRoute() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen
        options={{ title: t("subscriptions.freeze.title"), animation: Platform.OS === "web" ? "fade" : "slide_from_bottom" }}
      />
      <FreezeSubscriptionForm subscriptionId={String(id)} />
    </>
  );
}
