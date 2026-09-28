import { Stack } from "expo-router";
import { AthleteSubscriptionScreen } from "../../../src/screens/AthleteSubscriptionScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function AthleteSubscriptionRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("athleteSubscription.title") }} />
      <AthleteSubscriptionScreen />
    </>
  );
}
