import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

export type RealtimeTableSub = {
  table: string;
  /** Postgres Changes filter, e.g. `session_id=eq.${id}` — scopes events to just this screen's row(s). */
  filter?: string;
};

/**
 * Monotonic per-hook-instance suffix so two mounts (e.g. leaving a screen and coming right back
 * to it) never share a channel topic name. `removeChannel` on unmount does a network round trip
 * to actually leave the channel server-side, so it isn't guaranteed to finish before a fast
 * remount tries to open a "new" channel — if the name were deterministic, that remount would
 * collide with the still-closing old one and Supabase throws "cannot add postgres_changes
 * callbacks... after channel has been subscribed". A unique name per mount sidesteps the race
 * entirely regardless of how fast the old one tears down.
 */
let instanceCounter = 0;

/**
 * Subscribes to Postgres Changes (insert/update/delete) on the given tables and calls
 * `onChange` — debounced, so a burst of changes triggers one refetch, not several — instead of
 * waiting for a manual pull-to-refresh. Reuses whatever fetch function the caller already has;
 * this hook only decides *when* to call it, not how to merge data.
 */
export function useRealtimeRefetch(subs: RealtimeTableSub[], onChange: () => void, debounceMs = 500) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const subsKey = subs.map((s) => `${s.table}:${s.filter ?? ""}`).join("|");

  useEffect(() => {
    if (!subsKey) return;
    const instanceId = ++instanceCounter;
    const channel = supabase.channel(`realtime-refetch:${instanceId}:${subsKey}`);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onChangeRef.current(), debounceMs);
    };

    for (const sub of subs) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: sub.table,
          ...(sub.filter ? { filter: sub.filter } : {}),
        },
        scheduleRefetch
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsKey, debounceMs]);
}
