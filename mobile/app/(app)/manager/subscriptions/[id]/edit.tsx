import { Platform } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { EditSubscriptionForm } from "../../../../../src/components/subscriptions/EditSubscriptionForm";
import { useI18n } from "../../../../../src/context/I18nContext";

export default function ManagerEditSubscriptionRoute() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen
        options={{ title: t("subscriptions.edit.title"), animation: Platform.OS === "web" ? "fade" : "slide_from_bottom" }}
      />
      <EditSubscriptionForm subscriptionId={String(id)} />
    </>
  );
}
