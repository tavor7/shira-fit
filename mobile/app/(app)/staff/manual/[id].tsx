import { Stack } from "expo-router";
import StaffEditManualParticipantScreen from "../../../../src/screens/StaffEditManualParticipantScreen";
import { useI18n } from "../../../../src/context/I18nContext";

export default function StaffManualParticipantRoute() {
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("screen.staffManualParticipant") }} />
      <StaffEditManualParticipantScreen />
    </>
  );
}
