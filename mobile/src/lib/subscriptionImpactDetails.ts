import { supabase } from "./supabase";
import type { ImpactRegistrationItem } from "./subscriptions";

/** Session time and coach for an impact row (Phase 5 / S). Presentation only — read with the manager's own access. */
export type ImpactSessionDetail = { time: string | null; coach: string | null };

export function impactItemKey(item: Pick<ImpactRegistrationItem, "registration_id" | "manual_participant_id">): string {
  return item.registration_id ? `r:${item.registration_id}` : `m:${item.manual_participant_id ?? ""}`;
}

/**
 * Looks up when and with whom each affected registration takes place. The impact itself (which rows,
 * how many) still comes only from the server preview; if this lookup fails the dialog shows dates only.
 */
export async function fetchImpactSessionDetails(
  items: Pick<ImpactRegistrationItem, "registration_id" | "manual_participant_id">[]
): Promise<Map<string, ImpactSessionDetail>> {
  const out = new Map<string, ImpactSessionDetail>();
  const regIds = [...new Set(items.map((i) => i.registration_id).filter((x): x is string => !!x))];
  const manIds = [...new Set(items.map((i) => i.manual_participant_id).filter((x): x is string => !!x))];
  if (regIds.length === 0 && manIds.length === 0) return out;

  const [regs, mans] = await Promise.all([
    regIds.length ? supabase.from("session_registrations").select("id, session_id").in("id", regIds) : Promise.resolve({ data: [], error: null }),
    manIds.length ? supabase.from("session_manual_participants").select("id, session_id").in("id", manIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (regs.error || mans.error) return out;
  const sessionOf = new Map<string, string>();
  for (const r of (regs.data ?? []) as { id: string; session_id: string }[]) sessionOf.set(`r:${r.id}`, r.session_id);
  for (const m of (mans.data ?? []) as { id: string; session_id: string }[]) sessionOf.set(`m:${m.id}`, m.session_id);
  const sessionIds = [...new Set(sessionOf.values())];
  if (sessionIds.length === 0) return out;

  const { data, error } = await supabase
    .from("training_sessions")
    .select("id, start_time, trainer:profiles!coach_id(full_name)")
    .in("id", sessionIds);
  if (error) return out;
  const bySession = new Map<string, ImpactSessionDetail>();
  for (const s of (data ?? []) as { id: string; start_time: string | null; trainer: { full_name: string | null } | { full_name: string | null }[] | null }[]) {
    const trainer = Array.isArray(s.trainer) ? s.trainer[0] : s.trainer;
    bySession.set(s.id, { time: s.start_time ? String(s.start_time).slice(0, 5) : null, coach: trainer?.full_name?.trim() || null });
  }
  for (const [key, sid] of sessionOf) {
    const d = bySession.get(sid);
    if (d) out.set(key, d);
  }
  return out;
}

export type ImpactDateGroup<T> = { date: string; items: T[] };

/** Groups rows by session date (input order kept inside a day; days ascending). */
export function groupImpactByDate<T extends { session_date: string }>(rows: T[], timeOf: (row: T) => string | null): ImpactDateGroup<T>[] {
  const sorted = [...rows].sort((a, b) => {
    const d = String(a.session_date).localeCompare(String(b.session_date));
    return d !== 0 ? d : (timeOf(a) ?? "99:99").localeCompare(timeOf(b) ?? "99:99");
  });
  const groups: ImpactDateGroup<T>[] = [];
  for (const r of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === r.session_date) last.items.push(r);
    else groups.push({ date: r.session_date, items: [r] });
  }
  return groups;
}
