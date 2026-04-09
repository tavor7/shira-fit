import { Redirect } from "expo-router";

export const options = { title: "" };

export default function CoachSessionsReportRedirect() {
  return <Redirect href="/(app)/manager/reports?tab=coach" />;
}
