import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";

/** Registration row joined with athlete profile. */
export type SessionRegistrationWithProfile = {
  user_id: string;
  attended: boolean | null;
  charge_no_show?: boolean | null;
  payment_method?: string | null;
  amount_paid?: number | string | null;
  profile: {
    full_name: string;
    username?: string;
    phone?: string | null;
    date_of_birth?: string | null;
  } | null;
};

/**
 * Active registrations of a session with the athlete's profile, in one request (Performance Phase 5; it used to be
 * registrations, then profiles, one after the other). The foreign key is named explicitly because session_registrations
 * has two relationships to profiles (user_id and payment_recorded_by). The embedded profile is read under the same RLS as
 * a separate profiles query, so the same rows are visible; a profile the caller may not read is null, as before.
 */
export async function fetchSessionRegistrationsWithProfiles(
  sessionId: string
): Promise<{ rows: SessionRegistrationWithProfile[]; error: string | null }> {
  const base = "user_id, attended, charge_no_show, payment_method, amount_paid";
  let res = await supabase
    .from("session_registrations")
    .select(`${base}, profile:profiles!session_registrations_user_id_fkey(user_id, full_name, username, phone, date_of_birth)`)
    .eq("session_id", sessionId)
    .eq("status", "active");
  if (res.error && isMissingColumnError(res.error.message, "date_of_birth")) {
    res = (await supabase
      .from("session_registrations")
      .select(`${base}, profile:profiles!session_registrations_user_id_fkey(user_id, full_name, username, phone)`)
      .eq("session_id", sessionId)
      .eq("status", "active")) as typeof res;
  }
  if (res.error) return { rows: [], error: res.error.message };
  const rows = ((res.data ?? []) as unknown as (Omit<SessionRegistrationWithProfile, "profile"> & {
    profile: SessionRegistrationWithProfile["profile"] | SessionRegistrationWithProfile["profile"][];
  })[]).map((r) => ({ ...r, profile: Array.isArray(r.profile) ? r.profile[0] ?? null : r.profile ?? null }));
  return { rows, error: null };
}

export type RosterAthleteEntry = { name: string; phone: string | null };

/** Batch roster names for calendar / exports (no embed). */
export async function fetchRegistrationAthletesBySessionIds(
  sessionIds: string[]
): Promise<{ bySession: Record<string, RosterAthleteEntry[]>; error: string | null }> {
  const out: Record<string, RosterAthleteEntry[]> = {};
  for (const id of sessionIds) out[id] = [];
  if (sessionIds.length === 0) return { bySession: out, error: null };

  const { data: regs, error: regErr } = await supabase
    .from("session_registrations")
    .select("session_id, user_id")
    .in("session_id", sessionIds)
    .eq("status", "active");

  if (regErr) return { bySession: out, error: regErr.message };

  const list = (regs ?? []) as { session_id: string; user_id: string }[];
  if (list.length === 0) return { bySession: out, error: null };

  const userIds = [...new Set(list.map((r) => r.user_id))];
  const { data: profiles, error: profErr } = await supabase
    .from("profiles")
    .select("user_id, full_name, phone")
    .in("user_id", userIds);

  if (profErr) return { bySession: out, error: profErr.message };

  const byUserId = new Map(
    ((profiles ?? []) as { user_id: string; full_name: string; phone?: string | null }[]).map((p) => [p.user_id, p])
  );

  for (const r of list) {
    const p = byUserId.get(r.user_id);
    const name = String(p?.full_name ?? "").trim();
    if (!name) continue;
    const phoneRaw = String(p?.phone ?? "").trim();
    out[r.session_id]?.push({ name, phone: phoneRaw.length > 0 ? phoneRaw : null });
  }

  return { bySession: out, error: null };
}
