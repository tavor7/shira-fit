import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { rpcGetMySubscriptionTerms, type SubscriptionTermsDocument } from "../lib/subscriptionTerms";

const REFRESH_MS = 60_000;
/**
 * Performance Phase 3: a navigation re-checks only when the last check is at least this old. Login, resume and the
 * REFRESH_MS timer still always check, so the gate is never more than REFRESH_MS behind the server (same bound as
 * before); it just no longer sends a request on every screen change (it was the most-called RPC in production).
 */
const NAVIGATION_RECHECK_MS = 30_000;

export type SubscriptionTermsGateState = {
  loading: boolean;
  /** Present only while the signed-in user must accept the subscription terms (server status "pending"). */
  document: SubscriptionTermsDocument | null;
  reload: () => Promise<void>;
};

/**
 * Mandatory subscription-terms screen state. The server decides (get_my_subscription_terms): the user must accept when
 * enforcement is on, they have an applicable subscription and they have not accepted the required version. Re-checked on
 * login, when the app returns to the foreground, every minute and on navigation (at most every 30 s), so a subscription created (or
 * cancelled) - or the manager turning enforcement on or off - reaches an open app without a reload or a deployment.
 * A failed check never blocks the app; the server still refuses the athlete's own registrations while acceptance is
 * pending.
 */
export function useSubscriptionTermsGate(): SubscriptionTermsGateState {
  const { session } = useAuth();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [document, setDocument] = useState<SubscriptionTermsDocument | null>(null);
  const userId = session?.user?.id ?? null;
  const lastCheckRef = useRef<{ userId: string | null; at: number }>({ userId: null, at: 0 });

  const reload = useCallback(async () => {
    if (!userId) {
      setDocument(null);
      setLoading(false);
      return;
    }
    lastCheckRef.current = { userId, at: Date.now() };
    try {
      const res = await rpcGetMySubscriptionTerms(supabase);
      setDocument(res.ok && res.blocking && res.document ? res.document : null);
    } catch {
      setDocument(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Login / user change: always. Navigation: when the last check is NAVIGATION_RECHECK_MS old.
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const last = lastCheckRef.current;
    if (last.userId === userId && Date.now() - last.at < NAVIGATION_RECHECK_MS) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, userId]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { loading, document, reload };
}
