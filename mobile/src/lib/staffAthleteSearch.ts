import { supabase } from "./supabase";

export function escapeIlike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export type StaffAthleteSearchHit =
  | { kind: "app"; id: string; fullName: string; username: string; phone: string }
  | { kind: "manual"; id: string; fullName: string; phone: string };

export async function searchStaffAthletes(termRaw: string, limit = 50): Promise<StaffAthleteSearchHit[]> {
  const term = termRaw.trim();
  const safe = escapeIlike(term);

  let pQuery = supabase
    .from("profiles")
    .select("user_id, full_name, username, phone")
    .eq("role", "athlete")
    .order("full_name", { ascending: true })
    .limit(limit);
  if (term.length > 0) {
    pQuery = pQuery.or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }

  let mQuery = supabase
    .from("manual_participants")
    .select("id, full_name, phone")
    .is("disabled_at", null)
    .order("full_name", { ascending: true })
    .limit(limit);
  if (term.length > 0) {
    mQuery = mQuery.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }

  const [{ data: profiles, error: pErr }, { data: manuals, error: mErr }] = await Promise.all([pQuery, mQuery]);

  const hits: StaffAthleteSearchHit[] = [];

  if (!pErr) {
    for (const r of (profiles ?? []) as { user_id: string; full_name: string; username: string; phone: string }[]) {
      hits.push({
        kind: "app",
        id: r.user_id,
        fullName: r.full_name ?? "—",
        username: r.username ?? "",
        phone: r.phone ?? "",
      });
    }
  }

  if (!mErr) {
    for (const r of (manuals ?? []) as { id: string; full_name: string; phone: string }[]) {
      hits.push({
        kind: "manual",
        id: r.id,
        fullName: r.full_name ?? "—",
        phone: r.phone ?? "",
      });
    }
  }

  hits.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
  return hits.slice(0, limit);
}
