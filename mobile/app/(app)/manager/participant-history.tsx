import { Redirect } from "expo-router";

export const options = { title: "" };

export default function ParticipantHistoryRedirect() {
  return <Redirect href="/(app)/manager/reports?tab=athlete" />;
}
