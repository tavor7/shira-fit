import { Stack } from "expo-router";
import SuperUserHiddenWorkoutsScreen from "../../../src/screens/SuperUserHiddenWorkoutsScreen";
import { useI18n } from "../../../src/context/I18nContext";

export default function SuperUserHiddenWorkoutsRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.superUserHidden") }} />
      <SuperUserHiddenWorkoutsScreen />
    </>
  );
}
