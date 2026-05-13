import { theme } from "../theme";

/** Border + marker colors for studio calendar notes (week chips, day sheet, kind picker). */
export function studioCalendarNoteAccent(kind: string): { border: string; dot: string } {
  if (kind === "closure") return { border: theme.colors.errorBorder, dot: theme.colors.error };
  if (kind === "info") return { border: theme.colors.calendarNoteInfo, dot: theme.colors.calendarNoteInfo };
  return { border: theme.colors.calendarNoteHoliday, dot: theme.colors.calendarNoteHoliday };
}
