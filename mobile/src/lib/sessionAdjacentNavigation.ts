import type { TrainingSessionWithTrainer } from "../types/database";
import { fetchAthleteOpenSessionsForCalendar, fetchStaffTrainingSessionsForCalendar } from "./trainingSessionQueries";

export type AdjacentSessionIds = { prevId: string | null; nextId: string | null };

function adjacentFromOrderedIds(ids: string[], currentId: string): AdjacentSessionIds {
  const i = ids.indexOf(currentId);
  if (i < 0) return { prevId: null, nextId: null };
  return {
    prevId: i > 0 ? ids[i - 1]! : null,
    nextId: i < ids.length - 1 ? ids[i + 1]! : null,
  };
}

/** Same ordering as staff calendar (`fetchStaffTrainingSessionsForCalendar`). */
export async function getStaffAdjacentSessionIds(currentSessionId: string): Promise<AdjacentSessionIds> {
  const sid = String(currentSessionId ?? "").trim();
  if (!sid) return { prevId: null, nextId: null };
  const { data, error } = await fetchStaffTrainingSessionsForCalendar();
  if (error || !data?.length) return { prevId: null, nextId: null };
  const ids = (data as TrainingSessionWithTrainer[]).map((s) => s.id);
  return adjacentFromOrderedIds(ids, sid);
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
