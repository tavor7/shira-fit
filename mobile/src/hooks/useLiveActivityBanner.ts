import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";

export type LiveActivityBannerItem = {
  id: string;
  message: string;
  tone: "success" | "error";
};

type NewRow = { user_id?: string; session_id?: string };

/**
 * Watches for new registrations/cancellations (insert-only, not the debounced `useRealtimeRefetch`
 * used for silent refetching) and queues a human-readable banner item for each one — one at a
 * time, so a burst of activity shows as a short sequence rather than overlapping messages.
 * `getSessionLabel` looks up a short label (e.g. "Tue 19:00") from whatever session list the
 * caller already has loaded; returns null if unknown, in which case the label is just omitted.
 */
export function useLiveActivityBanner(
  enabled: boolean,
  getSessionLabel: (sessionId: string) => string | null
): { current: LiveActivityBannerItem | null; dismissCurrent: () => void } {
  const { t } = useI18n();
  const [queue, setQueue] = useState<LiveActivityBannerItem[]>([]);
  const labelRef = useRef(getSessionLabel);
  labelRef.current = getSessionLabel;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled) return;

    const channelName = `live-activity:${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel(channelName);

    async function nameFor(userId: string): Promise<string> {
      try {
        const { data } = await supabase.from("profiles").select("full_name").eq("user_id", userId).single();
        const name = (data as { full_name?: string } | null)?.full_name?.trim();
        return name || tRef.current("liveActivity.someone");
      } catch {
        return tRef.current("liveActivity.someone");
      }
    }

    function enqueue(message: string, tone: LiveActivityBannerItem["tone"]) {
      setQueue((q) => [...q, { id: `${Date.now()}-${Math.random()}`, message, tone }]);
    }

    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "session_registrations" },
      async (payload) => {
        const row = payload.new as NewRow;
        if (!row.user_id || !row.session_id) return;
        const name = await nameFor(row.user_id);
        const label = labelRef.current(row.session_id);
        const key = label ? "liveActivity.registeredFor" : "liveActivity.registered";
        enqueue(tRef.current(key).replace("{name}", name).replace("{session}", label ?? ""), "success");
      }
    );

    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "cancellations" },
      async (payload) => {
        const row = payload.new as NewRow;
        if (!row.user_id || !row.session_id) return;
        const name = await nameFor(row.user_id);
        const label = labelRef.current(row.session_id);
        const key = label ? "liveActivity.cancelledFor" : "liveActivity.cancelled";
        enqueue(tRef.current(key).replace("{name}", name).replace("{session}", label ?? ""), "error");
      }
    );

    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled]);

  function dismissCurrent() {
    setQueue((q) => q.slice(1));
  }

  return { current: queue[0] ?? null, dismissCurrent };
}
