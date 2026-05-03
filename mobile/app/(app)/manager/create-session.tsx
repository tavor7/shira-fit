import { Stack, useLocalSearchParams } from "expo-router";
import { CreateSessionForm } from "../../../src/components/CreateSessionForm";
import { useI18n } from "../../../src/context/I18nContext";

export default function ManagerCreateSessionScreen() {
  const { t } = useI18n();
  const { date } = useLocalSearchParams<{ date?: string | string[] }>();
  const initialDate = Array.isArray(date) ? date[0] : date;
  return (
    <>
      <Stack.Screen options={{ title: t("screen.managerCreateSession") }} />
      <CreateSessionForm initialDate={initialDate} />
    </>
  );
}
