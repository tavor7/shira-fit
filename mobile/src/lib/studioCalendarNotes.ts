import { supabase } from "./supabase";
import type { StudioCalendarNoteRow } from "../types/database";

export type StudioCalendarNote = StudioCalendarNoteRow;

/** Inclusive range overlap: note intersects [weekStart, weekEnd] (ISO dates). */
export function studioNoteOverlapsRange(
  note: Pick<StudioCalendarNote, "start_date" | "end_date">,
  weekStart: string,
  weekEnd: string
): boolean {
  return note.start_date <= weekEnd && note.end_date >= weekStart;
}

export function studioNoteCoversDate(note: Pick<StudioCalendarNote, "start_date" | "end_date">, isoDate: string): boolean {
  return note.start_date <= isoDate && note.end_date >= isoDate;
}

export async function fetchStudioCalendarNotesForRange(
  weekStart: string,
  weekEnd: string
): Promise<StudioCalendarNote[]> {
  if (!weekStart || !weekEnd || weekStart > weekEnd) return [];
  const { data, error } = await supabase
    .from("studio_calendar_notes")
    .select("id,start_date,end_date,title,detail,kind,audience,created_at,updated_at")
    .lte("start_date", weekEnd)
    .gte("end_date", weekStart)
    .order("start_date", { ascending: true });
  if (error) {
    console.warn("studio_calendar_notes fetch:", error.message);
    return [];
  }
  return (data as StudioCalendarNote[]) ?? [];
}
