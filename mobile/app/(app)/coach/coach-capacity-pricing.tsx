import { Redirect } from "expo-router";

/** Legacy route: combined pricing hub. */
export default function CoachCoachCapacityPricingRedirect() {
  return <Redirect href="/(app)/coach/pricing?tab=coach" />;
}
