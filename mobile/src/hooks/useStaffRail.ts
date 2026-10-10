import { Platform, useWindowDimensions } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useEffectiveNavRole } from "../context/ManagerAthletePreviewContext";

/** Width from which staff get a persistent side rail instead of the ≡ menu (Phase 5 / D). */
export const STAFF_RAIL_MIN_WIDTH = 1024;

/** Coaches and managers (not in athlete preview) on wide web screens. Native and phones keep the menu. */
export function useStaffRailVisible(): boolean {
  const { profile } = useAuth();
  const navRole = useEffectiveNavRole(profile);
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= STAFF_RAIL_MIN_WIDTH && (navRole === "manager" || navRole === "coach");
}
