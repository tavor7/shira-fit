import { supabase } from "./supabase";
import { isMissingColumnError } from "./dbColumnErrors";

/** Registration row joined with athlete profile (two queries — avoids PostgREST embed ambiguity). */
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

export async function fetchSessionRegistrationsWithProfiles(
  sessionId: string
): Promise<{ rows: SessionRegistrationWithProfile[]; error: string | null }> {
  const { data: regs, error: regErr } = await supabase
    .from("session_registrations")
    .select("user_id, attended, charge_no_show, payment_method, amount_paid")
    .eq("session_id", sessionId)
    .eq("status", "active");

  if (regErr) return { rows: [], error: regErr.message };

  const list = (regs ?? []) as Omit<SessionRegistrationWithProfile, "profile">[];
  if (list.length === 0) return { rows: [], error: null };

  const userIds = [...new Set(list.map((r) => r.user_id))];
  let profRes = await supabase
    .from("profiles")
    .select("user_id, full_name, username, phone, date_of_birth")
    .in("user_id", userIds);

  if (profRes.error && isMissingColumnError(profRes.error.message, "date_of_birth")) {
    profRes = (await supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .in("user_id", userIds)) as typeof profRes;
  }

  if (profRes.error) return { rows: [], error: profRes.error.message };

  const byUserId = new Map(
    ((profRes.data ?? []) as { user_id: string; full_name: string; username?: string; phone?: string | null; date_of_birth?: string | null }[]).map(
      (p) => [p.user_id, p]
    )
  );

  return {
    rows: list.map((r) => ({
      ...r,
      profile: byUserId.get(r.user_id) ?? null,
    })),
    error: null,
  };
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
