import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

const Ctx = createContext<number | null>(null);

/**
 * Tracks "this user has the app open" on one shared Realtime Presence channel for the whole
 * authenticated session (mounted once in the (app) layout), and exposes a live count via
 * `useActiveUserCount()`. Deliberately minimal: just a number, no per-user detail, no polling.
 */
export function AppPresenceProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const userId = profile?.user_id ?? null;

  useEffect(() => {
    if (!userId) {
      setCount(null);
      return;
    }

    const channel = supabase.channel("app-presence", {
      config: { presence: { key: userId } },
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      setCount(Object.keys(state).length);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void channel.track({ userId });
      }
    });

    return () => {
      setCount(null);
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return <Ctx.Provider value={count}>{children}</Ctx.Provider>;
}

/** Live count of authenticated users with the app open right now (including yourself), or null until known. */
export function useActiveUserCount(): number | null {
  return useContext(Ctx);
}
