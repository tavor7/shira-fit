import { supabase } from "./supabase";

export type CreateSessionSeriesParams = {
  anchorDate: string;
  startTime: string;
  coachId: string;
  maxParticipants: number;
  durationMinutes: number;
  isOpen: boolean;
  isHidden: boolean;
  isKickbox: boolean;
  customSlotPriceIls: number | null;
  repeatMode: "ongoing" | "fixed_weeks";
  fixedWeeks?: number;
  copyRoster: boolean;
  athleteIds: string[];
  manualIds: string[];
};

export type CreateSessionSeriesResult = {
  ok: boolean;
  series_id?: string;
  session_ids?: string[];
  count?: number;
  error?: string;
};

export async function staffCreateSessionSeries(
  params: CreateSessionSeriesParams
): Promise<CreateSessionSeriesResult> {
  const { data, error } = await supabase.rpc("staff_create_session_series", {
    p_anchor_date: params.anchorDate,
    p_start_time: params.startTime,
    p_coach_id: params.coachId,
    p_max_participants: params.maxParticipants,
    p_duration_minutes: params.durationMinutes,
    p_is_open: params.isOpen,
    p_is_hidden: params.isHidden,
    p_is_kickbox: params.isKickbox,
    p_custom_slot_price_ils: params.customSlotPriceIls,
    p_repeat_mode: params.repeatMode,
    p_fixed_weeks: params.repeatMode === "fixed_weeks" ? params.fixedWeeks ?? 4 : null,
    p_copy_roster: params.copyRoster,
    p_athlete_ids: params.athleteIds,
    p_manual_ids: params.manualIds,
  });
  if (error) return { ok: false, error: error.message };
  const raw = data as Record<string, unknown> | null;
  if (!raw?.ok) return { ok: false, error: String(raw?.error ?? "failed") };
  return {
    ok: true,
    series_id: String(raw.series_id ?? ""),
    session_ids: Array.isArray(raw.session_ids) ? (raw.session_ids as string[]) : [],
    count: Number(raw.count ?? 0),
  };
}

/** Extend ongoing series through the rolling horizon (~5 weeks ahead). */
export async function maintainSessionSeriesHorizon(): Promise<{ ok: boolean; created?: number; error?: string }> {
  const { data, error } = await supabase.rpc("maintain_session_series_horizon");
  if (error) return { ok: false, error: error.message };
  const raw = data as Record<string, unknown> | null;
  if (!raw?.ok) return { ok: false, error: String(raw?.error ?? "failed") };
  return { ok: true, created: Number(raw.created ?? 0) };
}

export type SeriesScope = "this" | "future";

export function isSessionInActiveSeries(session: {
  series_id?: string | null;
  series_detached?: boolean;
}): boolean {
  return Boolean(session.series_id && !session.series_detached);
}

export async function deleteSessionWithSeriesScope(
  sessionId: string,
  scope: SeriesScope
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc("staff_delete_session_series_scope", {
    p_session_id: sessionId,
    p_scope: scope,
  });
  if (error) return { ok: false, error: error.message };
  const raw = data as Record<string, unknown> | null;
  if (!raw?.ok) return { ok: false, error: String(raw?.error ?? "failed") };
  return { ok: true };
}

export type UpdateSessionSeriesScopeParams = {
  sessionId: string;
  scope: SeriesScope;
  sessionDate: string;
  startTime: string;
  coachId: string;
  maxParticipants: number;
  durationMinutes: number;
  isOpen: boolean;
  isHidden: boolean;
  isKickbox: boolean;
  customSlotPriceIls: number | null;
};

export async function updateSessionWithSeriesScope(
  params: UpdateSessionSeriesScopeParams
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc("staff_update_session_series_scope", {
    p_session_id: params.sessionId,
    p_scope: params.scope,
    p_session_date: params.sessionDate,
    p_start_time: params.startTime,
    p_coach_id: params.coachId,
    p_max_participants: params.maxParticipants,
    p_duration_minutes: params.durationMinutes,
    p_is_open: params.isOpen,
    p_is_hidden: params.isHidden,
    p_is_kickbox: params.isKickbox,
    p_custom_slot_price_ils: params.customSlotPriceIls,
  });
  if (error) return { ok: false, error: error.message };
  const raw = data as Record<string, unknown> | null;
  if (!raw?.ok) return { ok: false, error: String(raw?.error ?? "failed") };
  return { ok: true };
}

export function formatSessionSeriesError(error: string | undefined, translate: (key: string) => string): string {
  const e = String(error ?? "");
  if (e === "series_date_conflict" || e.includes("training_sessions_series_date_uidx")) {
    return translate("session.seriesDateConflict");
  }
  return e;
}

export function isMissingSessionSeriesRpc(err: { message?: string } | null | undefined): boolean {
  const m = String(err?.message ?? "").toLowerCase();
  return (
    m.includes("staff_create_session_series") ||
    m.includes("staff_delete_session_series_scope") ||
    m.includes("staff_update_session_series_scope") ||
    m.includes("maintain_session_series_horizon") ||
    m.includes("could not find the function") ||
    m.includes("schema cache")
  );
}
