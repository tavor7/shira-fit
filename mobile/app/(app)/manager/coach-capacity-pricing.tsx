import { Redirect } from "expo-router";

/** Legacy route: combined hub under Overview → Pricing. */
export default function ManagerCoachCapacityPricingRedirect() {
  return <Redirect href="/(app)/manager/pricing?tab=coach" />;
}
