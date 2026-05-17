/** Parsed shapes from `manager_weekly_stats` finance + overview extras. */

export type WeeklyFinanceCoachSession = {
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
  registered_count: number;
  group_capacity: number;
  tier_registered: number;
  rate_ils: number | null;
  payout_ils: number;
  rate_missing: boolean;
};

export type WeeklyFinanceCoach = {
  coach_id: string;
  name: string | null;
  payout_ils: number;
  has_rate_gap: boolean;
  sessions: WeeklyFinanceCoachSession[];
};

export type WeeklyFinanceAthleteTotals = {
  expected_ils: number;
  collected_sessions_ils: number;
  collected_account_ils: number;
  collected_total_ils: number;
  outstanding_ils: number;
};

export type WeeklyFinanceAthlete = {
  kind: "app" | "manual";
  id: string;
  name: string | null;
  expected_ils: number;
  collected_sessions_ils: number;
  collected_account_ils: number;
  collected_total_ils: number;
  outstanding_ils: number;
};

export type DailyCollectionSession = {
  session_id: string;
  start_time: string;
  coach_name: string | null;
  collected_ils: number;
  max_participants: number;
  registered_count: number;
  arrived_count: number;
  late_cancel_charged_count: number;
};

export type DailyCollectionDay = {
  date: string;
  collected_ils: number;
  sessions_ils: number;
  account_ils: number;
  sessions: DailyCollectionSession[];
};

export type DailyExpectedSession = {
  session_id: string;
  start_time: string;
  coach_name: string | null;
  expected_ils: number;
  max_participants: number;
  registered_count: number;
  arrived_count: number;
  late_cancel_charged_count: number;
};

export type DailyExpectedDay = {
  date: string;
  expected_ils: number;
  sessions: DailyExpectedSession[];
};

/** Merged day/session row for expected + collected breakdown UI. */
export type FinanceBreakdownSession = {
  session_id: string;
  start_time: string;
  coach_name: string | null;
  expected_ils: number;
  collected_ils: number;
  max_participants: number;
  registered_count: number;
  arrived_count: number;
  late_cancel_charged_count: number;
};

export type FinanceBreakdownDay = {
  date: string;
  expected_ils: number;
  collected_ils: number;
  sessions_ils: number;
  account_ils: number;
  sessions: FinanceBreakdownSession[];
};

export type WeeklyFinance = {
  coaches: WeeklyFinanceCoach[];
  athlete_totals: WeeklyFinanceAthleteTotals;
  athletes: WeeklyFinanceAthlete[];
  amounts_by_method: Record<string, number>;
  collections_by_day: DailyCollectionDay[];
  expected_by_day: DailyExpectedDay[];
};

export type MissingAttendanceSession = {
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
  coach_name: string | null;
  unset_count: number;
};

export type MissingAttendancePayload = {
  count: number;
  sessions: MissingAttendanceSession[];
};

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function parseCollectionsByDay(raw: unknown): DailyCollectionDay[] {
  if (!Array.isArray(raw)) return [];
  const out: DailyCollectionDay[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const date = String(r.date ?? "");
    if (!date) continue;
    const sessionsRaw = r.sessions;
    const sessions: DailyCollectionSession[] = [];
    if (Array.isArray(sessionsRaw)) {
      for (const s of sessionsRaw) {
        if (!s || typeof s !== "object") continue;
        const x = s as Record<string, unknown>;
        const session_id = String(x.session_id ?? "");
        if (!session_id) continue;
        sessions.push({
          session_id,
          start_time: String(x.start_time ?? ""),
          coach_name: x.coach_name == null ? null : String(x.coach_name),
          collected_ils: num(x.collected_ils),
          max_participants: num(x.max_participants),
          registered_count: num(x.registered_count),
          arrived_count: num(x.arrived_count),
          late_cancel_charged_count: num(x.late_cancel_charged_count),
        });
      }
    }
    out.push({
      date,
      collected_ils: num(r.collected_ils),
      sessions_ils: num(r.sessions_ils),
      account_ils: num(r.account_ils),
      sessions,
    });
  }
  return out;
}

export function parseExpectedByDay(raw: unknown): DailyExpectedDay[] {
  if (!Array.isArray(raw)) return [];
  const out: DailyExpectedDay[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const date = String(r.date ?? "");
    if (!date) continue;
    const sessionsRaw = r.sessions;
    const sessions: DailyExpectedSession[] = [];
    if (Array.isArray(sessionsRaw)) {
      for (const s of sessionsRaw) {
        if (!s || typeof s !== "object") continue;
        const x = s as Record<string, unknown>;
        const session_id = String(x.session_id ?? "");
        if (!session_id) continue;
        sessions.push({
          session_id,
          start_time: String(x.start_time ?? ""),
          coach_name: x.coach_name == null ? null : String(x.coach_name),
          expected_ils: num(x.expected_ils),
          max_participants: num(x.max_participants),
          registered_count: num(x.registered_count),
          arrived_count: num(x.arrived_count),
          late_cancel_charged_count: num(x.late_cancel_charged_count),
        });
      }
    }
    out.push({
      date,
      expected_ils: num(r.expected_ils),
      sessions,
    });
  }
  return out;
}

export function mergeFinanceBreakdownDays(finance: WeeklyFinance | null): FinanceBreakdownDay[] {
  if (!finance) return [];
  const collByDate = new Map(finance.collections_by_day.map((d) => [d.date, d]));
  const expByDate = new Map(finance.expected_by_day.map((d) => [d.date, d]));
  const dates = [...new Set([...collByDate.keys(), ...expByDate.keys()])].sort();

  return dates.map((date) => {
    const coll = collByDate.get(date);
    const exp = expByDate.get(date);
    const sessionIds = new Set<string>([
      ...(coll?.sessions.map((s) => s.session_id) ?? []),
      ...(exp?.sessions.map((s) => s.session_id) ?? []),
    ]);
    const sessions: FinanceBreakdownSession[] = [...sessionIds]
      .map((session_id) => {
        const c = coll?.sessions.find((s) => s.session_id === session_id);
        const e = exp?.sessions.find((s) => s.session_id === session_id);
        return {
          session_id,
          start_time: c?.start_time ?? e?.start_time ?? "",
          coach_name: c?.coach_name ?? e?.coach_name ?? null,
          expected_ils: e?.expected_ils ?? 0,
          collected_ils: c?.collected_ils ?? 0,
          max_participants: c?.max_participants ?? e?.max_participants ?? 0,
          registered_count: c?.registered_count ?? e?.registered_count ?? 0,
          arrived_count: c?.arrived_count ?? e?.arrived_count ?? 0,
          late_cancel_charged_count: c?.late_cancel_charged_count ?? e?.late_cancel_charged_count ?? 0,
        };
      })
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

    return {
      date,
      expected_ils: exp?.expected_ils ?? 0,
      collected_ils: coll?.collected_ils ?? 0,
      sessions_ils: coll?.sessions_ils ?? 0,
      account_ils: coll?.account_ils ?? 0,
      sessions,
    };
  });
}

export function parseMissingAttendance(raw: unknown): MissingAttendancePayload {
  if (!raw || typeof raw !== "object") return { count: 0, sessions: [] };
  const o = raw as Record<string, unknown>;
  const sessionsRaw = o.sessions;
  const sessions: MissingAttendanceSession[] = [];
  if (Array.isArray(sessionsRaw)) {
    for (const s of sessionsRaw) {
      if (!s || typeof s !== "object") continue;
      const x = s as Record<string, unknown>;
      const session_id = String(x.session_id ?? "");
      if (!session_id) continue;
      sessions.push({
        session_id,
        session_date: String(x.session_date ?? ""),
        start_time: String(x.start_time ?? ""),
        duration_minutes: num(x.duration_minutes, 60),
        coach_name: x.coach_name == null ? null : String(x.coach_name),
        unset_count: num(x.unset_count),
      });
    }
  }
  return { count: num(o.count, sessions.length), sessions };
}

export function parseFinance(raw: unknown): WeeklyFinance | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const coachesRaw = o.coaches;
  const coaches: WeeklyFinanceCoach[] = [];
  if (Array.isArray(coachesRaw)) {
    for (const c of coachesRaw) {
      if (!c || typeof c !== "object") continue;
      const r = c as Record<string, unknown>;
      const sid = String(r.coach_id ?? "");
      if (!sid) continue;
      const sessionsRaw = r.sessions;
      const sessions: WeeklyFinanceCoachSession[] = [];
      if (Array.isArray(sessionsRaw)) {
        for (const s of sessionsRaw) {
          if (!s || typeof s !== "object") continue;
          const x = s as Record<string, unknown>;
          const id = String(x.session_id ?? "");
          if (!id) continue;
          sessions.push({
            session_id: id,
            session_date: String(x.session_date ?? ""),
            start_time: String(x.start_time ?? ""),
            duration_minutes: num(x.duration_minutes, 60),
            registered_count: num(x.registered_count),
            group_capacity: num(x.group_capacity),
            tier_registered: num(x.tier_registered),
            rate_ils: x.rate_ils === null || x.rate_ils === undefined ? null : num(x.rate_ils),
            payout_ils: num(x.payout_ils),
            rate_missing: Boolean(x.rate_missing),
          });
        }
      }
      coaches.push({
        coach_id: sid,
        name: r.name == null ? null : String(r.name),
        payout_ils: num(r.payout_ils),
        has_rate_gap: Boolean(r.has_rate_gap),
        sessions,
      });
    }
  }

  const at = o.athlete_totals;
  let athlete_totals: WeeklyFinanceAthleteTotals = {
    expected_ils: 0,
    collected_sessions_ils: 0,
    collected_account_ils: 0,
    collected_total_ils: 0,
    outstanding_ils: 0,
  };
  if (at && typeof at === "object") {
    const t = at as Record<string, unknown>;
    athlete_totals = {
      expected_ils: num(t.expected_ils),
      collected_sessions_ils: num(t.collected_sessions_ils),
      collected_account_ils: num(t.collected_account_ils),
      collected_total_ils: num(t.collected_total_ils),
      outstanding_ils: num(t.outstanding_ils),
    };
  }

  const athletesRaw = o.athletes;
  const athletes: WeeklyFinanceAthlete[] = [];
  if (Array.isArray(athletesRaw)) {
    for (const a of athletesRaw) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      const kind = r.kind === "manual" ? "manual" : "app";
      const id = String(r.id ?? "");
      if (!id) continue;
      athletes.push({
        kind,
        id,
        name: r.name == null ? null : String(r.name),
        expected_ils: num(r.expected_ils),
        collected_sessions_ils: num(r.collected_sessions_ils),
        collected_account_ils: num(r.collected_account_ils),
        collected_total_ils: num(r.collected_total_ils),
        outstanding_ils: num(r.outstanding_ils),
      });
    }
  }

  const amb = o.amounts_by_method;
  const amounts_by_method: Record<string, number> = {};
  if (amb && typeof amb === "object" && !Array.isArray(amb)) {
    for (const [k, v] of Object.entries(amb as Record<string, unknown>)) {
      amounts_by_method[k] = num(v);
    }
  }

  return {
    coaches,
    athlete_totals,
    athletes,
    amounts_by_method,
    collections_by_day: parseCollectionsByDay(o.collections_by_day),
    expected_by_day: parseExpectedByDay(o.expected_by_day),
  };
}
