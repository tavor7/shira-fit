import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

export type RealtimeTableSub = {
  table: string;
  /** Postgres Changes filter, e.g. `session_id=eq.${id}` — scopes events to just this screen's row(s). */
  filter?: string;
};

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
    const channel = supabase.channel(`realtime-refetch:${subsKey}`);
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
