import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export type ActiveUser = {
  userId: string;
  name: string;
  role: "athlete" | "coach" | "manager";
};

const Ctx = createContext<ActiveUser[] | null>(null);

/**
 * Tracks "this user has the app open" on one shared Realtime Presence channel for the whole
 * authenticated session (mounted once in the (app) layout), and exposes the live list via
 * `useActiveUsers()` (or just a count via `useActiveUserCount()`).
 */
export function AppPresenceProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [users, setUsers] = useState<ActiveUser[] | null>(null);
  const userId = profile?.user_id ?? null;
  const name = profile?.full_name ?? null;
  const role = profile?.role ?? null;

  useEffect(() => {
    if (!userId || !name || !role) {
      setUsers(null);
      return;
    }

    const self: ActiveUser = { userId, name, role };
    const channel = supabase.channel("app-presence", {
      config: { presence: { key: userId } },
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<ActiveUser>();
      const list: ActiveUser[] = [];
      for (const key of Object.keys(state)) {
        const entry = state[key]?.[0];
        if (entry?.userId && entry?.name && entry?.role) {
          list.push({ userId: entry.userId, name: entry.name, role: entry.role });
        }
      }
      setUsers(list);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void channel.track(self);
      }
    });

    return () => {
      setUsers(null);
      void supabase.removeChannel(channel);
    };
  }, [userId, name, role]);

  return <Ctx.Provider value={users}>{children}</Ctx.Provider>;
}

/** Live list of authenticated users with the app open right now (including yourself), or null until known. */
export function useActiveUsers(): ActiveUser[] | null {
  return useContext(Ctx);
}

/** Just the count, for callers that don't need the list. */
export function useActiveUserCount(): number | null {
  const users = useContext(Ctx);
  return users?.length ?? null;
}
