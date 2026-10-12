import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { rpcGetMySubscriptionTerms, type SubscriptionTermsDocument } from "../lib/subscriptionTerms";

const REFRESH_MS = 60_000;

export type SubscriptionTermsGateState = {
  loading: boolean;
  /** Present only while the signed-in user must accept the subscription terms (server status "pending"). */
  document: SubscriptionTermsDocument | null;
  reload: () => Promise<void>;
};

/**
 * Mandatory subscription-terms screen state. The server decides (get_my_subscription_terms): the user must accept when
 * enforcement is on, they have an applicable subscription and they have not accepted the required version. Re-checked on
 * login, when the app returns to the foreground, on every navigation and every minute, so a subscription created (or
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

  const reload = useCallback(async () => {
    if (!userId) {
      setDocument(null);
      setLoading(false);
      return;
    }
    try {
      const res = await rpcGetMySubscriptionTerms(supabase);
      setDocument(res.ok && res.blocking && res.document ? res.document : null);
    } catch {
      setDocument(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload, pathname]);

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
