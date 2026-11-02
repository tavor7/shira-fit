import type { TrainingSessionWithTrainer } from "../types/database";
import { fetchAthleteOpenSessionsForCalendar } from "./trainingSessionQueries";
import { supabase } from "./supabase";

export type AdjacentSessionIds = { prevId: string | null; nextId: string | null };

function adjacentFromOrderedIds(ids: string[], currentId: string): AdjacentSessionIds {
  const i = ids.indexOf(currentId);
  if (i < 0) return { prevId: null, nextId: null };
  return {
    prevId: i > 0 ? ids[i - 1]! : null,
    nextId: i < ids.length - 1 ? ids[i + 1]! : null,
  };
}

/**
 * Same ordering as the staff calendar (session date, then start time), with the session id breaking ties so the order
 * is deterministic. Performance Phase 2: this used to download every session ever created (the whole calendar) on
 * each Session Detail open just to find two neighbours; it now asks for exactly the previous and the next one.
 */
export async function getStaffAdjacentSessionIds(currentSessionId: string): Promise<AdjacentSessionIds> {
  const sid = String(currentSessionId ?? "").trim();
  if (!sid) return { prevId: null, nextId: null };
  const { data: cur, error } = await supabase
    .from("training_sessions")
    .select("session_date, start_time")
    .eq("id", sid)
    .maybeSingle();
  if (error || !cur) return { prevId: null, nextId: null };
  const d = cur.session_date;
  const t = cur.start_time;
  const keyset = (op: "lt" | "gt") =>
    `session_date.${op}.${d},and(session_date.eq.${d},start_time.${op}."${t}"),and(session_date.eq.${d},start_time.eq."${t}",id.${op}.${sid})`;
  const neighbour = (op: "lt" | "gt") => {
    const ascending = op === "gt";
    return supabase
      .from("training_sessions")
      .select("id")
      .or(keyset(op))
      .order("session_date", { ascending })
      .order("start_time", { ascending })
      .order("id", { ascending })
      .limit(1);
  };
  const [prev, next] = await Promise.all([neighbour("lt"), neighbour("gt")]);
  if (prev.error || next.error) return { prevId: null, nextId: null };
  return { prevId: prev.data?.[0]?.id ?? null, nextId: next.data?.[0]?.id ?? null };
}

/** Same ordering as athlete calendar (`fetchAthleteOpenSessionsForCalendar`). */
export async function getAthleteAdjacentSessionIds(currentSessionId: string): Promise<AdjacentSessionIds> {
  const sid = String(currentSessionId ?? "").trim();
  if (!sid) return { prevId: null, nextId: null };
  const { data, error } = await fetchAthleteOpenSessionsForCalendar();
  if (error || !data?.length) return { prevId: null, nextId: null };
  const ids = (data as TrainingSessionWithTrainer[]).map((s) => s.id);
  return adjacentFromOrderedIds(ids, sid);
}
