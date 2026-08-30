import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export type PresentStaffMember = {
  userId: string;
  name: string;
  role: "coach" | "manager";
};

/**
 * Tracks which OTHER staff members currently have this session screen open, via Supabase
 * Realtime Presence — no polling, no extra table. `self` is the caller's own identity to
 * broadcast; pass `null` to skip tracking entirely (e.g. athletes should never join this channel).
 */
export function useSessionPresence(
  sessionId: string | null | undefined,
  self: PresentStaffMember | null
): PresentStaffMember[] {
  const [others, setOthers] = useState<PresentStaffMember[]>([]);

  useEffect(() => {
    if (!sessionId || !self?.userId) {
      setOthers([]);
      return;
    }

    const topic = `session-presence:${sessionId}`;

    // A fast remount (dev Fast Refresh, or quickly navigating away and back) can leave a
    // previous channel for this exact topic still mid-teardown when this effect re-runs.
    // supabase-js caches channels by topic and would hand back that same (already-subscribed)
    // instance below, and calling `.on()` on an already-subscribed channel throws "cannot add
    // presence callbacks ... after subscribe()". Evict any stale entry for this topic first —
    // the topic itself must stay stable (unlike useRealtimeRefetch's per-mount suffix trick)
    // since every staff member viewing this session needs to join the same channel.
    for (const existing of supabase.getChannels()) {
      if (existing.topic.endsWith(topic)) {
        void supabase.removeChannel(existing);
      }
    }

    const channel = supabase.channel(topic, {
      config: { presence: { key: self.userId } },
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresentStaffMember>();
      const list: PresentStaffMember[] = [];
      for (const key of Object.keys(state)) {
        if (key === self.userId) continue;
        const entry = state[key]?.[0];
        if (entry?.userId && entry?.name && entry?.role) {
          list.push({ userId: entry.userId, name: entry.name, role: entry.role });
        }
      }
      setOthers(list);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void channel.track(self);
      }
    });

    return () => {
      setOthers([]);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, self?.userId, self?.name, self?.role]);

  return others;
}
