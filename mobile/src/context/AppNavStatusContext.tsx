import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";
import { isAthleteAccountDisabled } from "../lib/profileAccount";
import { rpcGetMySubscription } from "../lib/athleteSubscription";

export type AppNavStatus = {
  /** Manager menu badge: athletes awaiting approval. */
  pendingApproveCount: number;
  /** Athlete menu: show "My Subscription" only when the athlete has one. */
  hasSubscription: boolean;
};

const EMPTY: AppNavStatus = { pendingApproveCount: 0, hasSubscription: false };
const Ctx = createContext<AppNavStatus>(EMPTY);

/**
 * The navigation menu's server-backed state, loaded once per navigation for the whole app (mounted once in the (app)
 * layout). Performance Phase 2: this used to live in every screen header's menu (and the desktop rail), so each mounted
 * screen ran the same two queries on every navigation - three to nine identical requests once a few screens were
 * stacked. Same freshness as before: re-read on every pathname change.
 */
export function AppNavStatusProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const pathname = usePathname() ?? "";
  const [pendingApproveCount, setPendingApproveCount] = useState(0);
  const [hasSubscription, setHasSubscription] = useState(false);

  useEffect(() => {
    if (profile?.role !== "manager") {
      setPendingApproveCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const { count, error } = await supabase
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "athlete")
        .eq("approval_status", "pending");
      if (!cancelled && !error) setPendingApproveCount(count ?? 0);
      if (!cancelled && error) setPendingApproveCount(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.role, pathname]);

  // "My Subscription" only belongs in this menu for an athlete who actually has one -- an
  // approved, non-disabled athlete with no subscription (the common case, since this is opt-in
  // manager-side) should never see a menu item that only leads to an empty state.
  useEffect(() => {
    const eligible =
      profile?.role === "athlete" && profile?.approval_status === "approved" && !isAthleteAccountDisabled(profile);
    if (!eligible) {
      setHasSubscription(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await rpcGetMySubscription(supabase);
        if (!cancelled) setHasSubscription(res.ok && res.has_subscription === true);
      } catch {
        if (!cancelled) setHasSubscription(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.role, profile?.approval_status, profile?.disabled_at, pathname]);

  const value = useMemo(() => ({ pendingApproveCount, hasSubscription }), [pendingApproveCount, hasSubscription]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppNavStatus(): AppNavStatus {
  return useContext(Ctx);
}
