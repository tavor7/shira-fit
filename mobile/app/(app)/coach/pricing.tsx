import { Stack } from "expo-router";
import { PricingHubScreen } from "../../../src/screens/PricingHubScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function CoachPricingRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("menu.pricingHub") }} />
      <PricingHubScreen variant="coach" />
    </>
  );
}
