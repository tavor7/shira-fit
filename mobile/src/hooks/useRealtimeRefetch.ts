import { useCallback, useEffect, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";

export type RealtimeTableSub = {
  table: string;
  /** Postgres Changes filter, e.g. `session_id=eq.${id}` — scopes events to just this screen's row(s). */
  filter?: string;
};

/**
 * What to do with a change that arrives while the screen is not the focused one (it is still mounted underneath a
 * pushed screen):
 * - "always": refetch anyway (the original behaviour).
 * - "skip": do nothing. Only for screens that already reload every time they regain focus, so nothing is lost.
 * - "deferUntilFocus": remember it and refetch once when the screen regains focus.
 */
export type RealtimeHiddenMode = "always" | "skip" | "deferUntilFocus";

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
 *
 * Performance Phase 2: menu navigation pushes screens, so earlier screens stay mounted underneath. With "always", every
 * hidden copy refetched on every change (one attendance tap on Session Detail reloaded each hidden staff home in
 * full). `whenHidden` lets a screen skip or defer that work; the subscription itself stays open, so no change is missed.
 */
export function useRealtimeRefetch(
  subs: RealtimeTableSub[],
  onChange: () => void,
  debounceMs = 500,
  whenHidden: RealtimeHiddenMode = "always"
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const focusedRef = useRef(true);
  const missedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (missedRef.current) {
        missedRef.current = false;
        if (whenHidden === "deferUntilFocus") onChangeRef.current();
      }
      return () => {
        focusedRef.current = false;
      };
    }, [whenHidden])
  );

  const subsKey = subs.map((s) => `${s.table}:${s.filter ?? ""}`).join("|");

  useEffect(() => {
    if (!subsKey) return;
    const instanceId = ++instanceCounter;
    const channel = supabase.channel(`realtime-refetch:${instanceId}:${subsKey}`);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (!focusedRef.current && whenHidden !== "always") {
        missedRef.current = true;
        return;
      }
      onChangeRef.current();
    };

    const scheduleRefetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
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
  }, [subsKey, debounceMs, whenHidden]);
}
