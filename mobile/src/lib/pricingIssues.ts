import type { SupabaseClient } from "@supabase/supabase-js";
import type { LanguageCode } from "../i18n/translations";
import { formatISODatePricing, toISODateLocal } from "./isoDate";
import {
  groupPricingByCapacity,
  groupPricingByTierKey,
  pricingActiveOnDate,
  pricingRangesOverlap,
  resolveTierPriceForDate,
  type PricingRatePeriod,
  type PricingRateTierRow,
} from "./pricingRates";
import { addDaysToISODate } from "./sessionTime";

export type PricingIssueSection = "standard" | "athlete" | "kickbox" | "coach";

export type PricingIssueFix =
  | { type: "edit_rate"; rateId: string; section: PricingIssueSection }
  | {
      type: "add_rate";
      section: PricingIssueSection;
      maxParticipants?: number;
      effectiveFrom?: string;
      userId?: string;
      manualParticipantId?: string;
      athleteLabel?: string;
      coachId?: string;
      isKickbox?: boolean;
    };

export type PricingIssueKind =
  | "overlap"
  | "gap_today"
  | "gap_between"
  | "gap_future"
  | "section_empty"
  | "section_no_active"
  | "session_missing_rate"
  | "athlete_billing_gap"
  | "coach_session_missing";

export type PricingIssueParams = {
  /** Tier, athlete, coach name, or section label */
  context?: string;
  rangeA?: string;
  rangeB?: string;
  gapRange?: string;
  /** Display date (localized). */
  date?: string;
  /** ISO date for sorting / deduping earliest occurrence. */
  dateIso?: string;
  capacity?: string;
  registered?: string;
  athleteName?: string;
  rateType?: string;
};

export type PricingIssue = {
  id: string;
  kind: PricingIssueKind;
  section: PricingIssueSection;
  severity: "error" | "warning";
  params: PricingIssueParams;
  fix?: PricingIssueFix;
};

type PeriodRow = PricingRatePeriod & {
  id?: string;
  max_participants: number;
  user_id?: string | null;
  manual_participant_id?: string | null;
};

export type PricingIssuesDetectOpts<T extends PeriodRow> = {
  /** Group rows before overlap/gap checks (e.g. per athlete + capacity). */
  tierKey?: (row: T) => string;
  /** Custom issue title; defaults to formatTier(capacity). */
  issueTitle?: (periods: T[]) => string;
};

function pricingRowGroups<T extends PeriodRow>(
  rows: T[],
  opts?: PricingIssuesDetectOpts<T>
): { groupId: string; capacity: number; periods: T[] }[] {
  if (opts?.tierKey) {
    return groupPricingByTierKey(rows, opts.tierKey).map((g) => ({
      groupId: g.tierKey,
      capacity: g.capacity,
      periods: g.periods,
    }));
  }
  return groupPricingByCapacity(rows).map((g) => ({
    groupId: String(g.capacity),
    capacity: g.capacity,
    periods: g.periods,
  }));
}

function addRateFixFields(
  row: PeriodRow | undefined,
  base: Extract<PricingIssueFix, { type: "add_rate" }>
): PricingIssueFix {
  if (!row?.user_id && !row?.manual_participant_id) return base;
  return {
    ...base,
    userId: row.user_id ?? undefined,
    manualParticipantId: row.manual_participant_id ?? undefined,
  };
}

function dayAfter(iso: string): string {
  return addDaysToISODate(iso, 1);
}

function dayBefore(iso: string): string {
  return addDaysToISODate(iso, -1);
}

export function detectPricingOverlaps<T extends PeriodRow>(
  rows: T[],
  section: PricingIssueSection,
  formatTier: (cap: number) => string,
  formatRange: (from: string, to: string | null | undefined) => string,
  opts?: PricingIssuesDetectOpts<T>
): PricingIssue[] {
  const issues: PricingIssue[] = [];
  const groups = pricingRowGroups(rows, opts);
  for (const { groupId, capacity, periods } of groups) {
    const title = opts?.issueTitle?.(periods) ?? formatTier(capacity);
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        const a = periods[i]!;
        const b = periods[j]!;
        if (!pricingRangesOverlap(a, b)) continue;
        const id = `overlap:${section}:${groupId}:${a.id ?? i}:${b.id ?? j}`;
        issues.push({
          id,
          kind: "overlap",
          section,
          severity: "error",
          params: {
            context: title,
            rangeA: formatRange(a.effective_from ?? "", a.effective_to),
            rangeB: formatRange(b.effective_from ?? "", b.effective_to),
          },
          fix: a.id
            ? { type: "edit_rate", rateId: a.id, section }
            : b.id
              ? { type: "edit_rate", rateId: b.id, section }
              : undefined,
        });
      }
    }
  }
  return issues;
}

export function detectPricingCoverageGaps<T extends PeriodRow>(
  rows: T[],
  section: PricingIssueSection,
  formatTier: (cap: number) => string,
  formatRange: (from: string, to: string | null | undefined) => string,
  asOf: string = toISODateLocal(new Date()),
  opts?: PricingIssuesDetectOpts<T>
): PricingIssue[] {
  const issues: PricingIssue[] = [];
  const groups = pricingRowGroups(rows, opts);
  for (const { groupId, capacity, periods } of groups) {
    const title = opts?.issueTitle?.(periods) ?? formatTier(capacity);
    const sample = periods[0];
    const sorted = [...periods]
      .filter((p) => p.effective_from)
      .sort((a, b) => (a.effective_from ?? "").localeCompare(b.effective_from ?? ""));
    if (sorted.length === 0) continue;

    const covers = (date: string) =>
      sorted.some((p) => pricingActiveOnDate(p.effective_from!, p.effective_to, date));

    if (!covers(asOf)) {
      issues.push({
        id: `gap:today:${section}:${groupId}`,
        kind: "gap_today",
        section,
        severity: "warning",
        params: {
          context: title,
          date: formatRange(asOf, asOf),
          dateIso: asOf,
        },
        fix: addRateFixFields(sample, {
          type: "add_rate",
          section,
          maxParticipants: capacity,
          effectiveFrom: asOf,
        }),
      });
    }

    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]!;
      const next = sorted[i + 1]!;
      const end = cur.effective_to?.trim();
      if (!end) continue;
      const gapStart = dayAfter(end);
      const gapEnd = dayBefore(next.effective_from!);
      if (gapStart <= gapEnd) {
        issues.push({
          id: `gap:mid:${section}:${groupId}:${gapStart}`,
          kind: "gap_between",
          section,
          severity: "warning",
          params: {
            context: title,
            gapRange: formatRange(gapStart, gapEnd),
            dateIso: gapStart,
          },
          fix: addRateFixFields(sample, {
            type: "add_rate",
            section,
            maxParticipants: capacity,
            effectiveFrom: gapStart,
          }),
        });
      }
    }

    const last = sorted[sorted.length - 1]!;
    const lastEnd = last.effective_to?.trim();
    if (lastEnd) {
      const gapStart = dayAfter(lastEnd);
      const horizon = addDaysToISODate(asOf, 365);
      if (gapStart <= horizon) {
        issues.push({
          id: `gap:future:${section}:${groupId}:${gapStart}`,
          kind: "gap_future",
          section,
          severity: "warning",
          params: {
            context: title,
            date: formatRange(gapStart, null),
            dateIso: gapStart,
          },
          fix: addRateFixFields(sample, {
            type: "add_rate",
            section,
            maxParticipants: capacity,
            effectiveFrom: gapStart,
          }),
        });
      }
    }
  }
  return issues;
}

export function detectNoPricingConfigured(
  rows: PeriodRow[],
  section: PricingIssueSection,
  label: string,
  asOf: string = toISODateLocal(new Date())
): PricingIssue[] {
  if (rows.length === 0) {
    return [
      {
        id: `empty:${section}`,
        kind: "section_empty",
        section,
        severity: "warning",
        params: { context: label },
        fix: { type: "add_rate", section, effectiveFrom: asOf },
      },
    ];
  }
  const anyActive = rows.some(
    (r) => r.effective_from && pricingActiveOnDate(r.effective_from, r.effective_to, asOf)
  );
  if (!anyActive) {
    return [
      {
        id: `inactive:${section}`,
        kind: "section_no_active",
        section,
        severity: "warning",
        params: { context: label, date: asOf, dateIso: asOf },
        fix: { type: "add_rate", section, effectiveFrom: asOf },
      },
    ];
  }
  return [];
}

type SessionAuditRow = {
  id: string;
  session_date: string;
  max_participants: number;
  is_kickbox: boolean | null;
  custom_slot_price_ils: number | null;
};

type RegistrationAuditRow = {
  session_id: string;
  user_id: string | null;
  manual_participant_id: string | null;
  session_date: string;
  max_participants: number;
  is_kickbox: boolean | null;
  custom_slot_price_ils: number | null;
  athlete_name: string;
};

export async function auditSessionPricingIssues(args: {
  supabase: SupabaseClient;
  globalRows: PricingRateTierRow[];
  kickboxRows: PricingRateTierRow[];
  athleteRows: (PricingRateTierRow & { user_id?: string | null; manual_participant_id?: string | null })[];
  language: LanguageCode;
  pastDays?: number;
  futureDays?: number;
  maxIssues?: number;
}): Promise<PricingIssue[]> {
  const {
    supabase,
    globalRows,
    kickboxRows,
    athleteRows,
    language,
    pastDays = 30,
    futureDays = 120,
    maxIssues = 25,
  } = args;
  const today = toISODateLocal(new Date());
  const start = addDaysToISODate(today, -pastDays);
  const end = addDaysToISODate(today, futureDays);

  const { data: sessions, error } = await supabase
    .from("training_sessions")
    .select("id, session_date, max_participants, is_kickbox, custom_slot_price_ils")
    .gte("session_date", start)
    .lte("session_date", end)
    .order("session_date", { ascending: true });

  if (error || !sessions?.length) return [];

  const issues: PricingIssue[] = [];
  const seenSession = new Set<string>();
  const seenAthlete = new Set<string>();

  for (const s of sessions as SessionAuditRow[]) {
    if (s.custom_slot_price_ils != null && Number.isFinite(Number(s.custom_slot_price_ils))) continue;
    const cap = s.max_participants;
    const date = s.session_date;
    const kick = !!s.is_kickbox;
    const tiers = kick ? kickboxRows : globalRows;
    const price = resolveTierPriceForDate(tiers, cap, date);
    if (price == null) {
      const sk = `${s.id}:${cap}:${kick ? "k" : "s"}`;
      if (!seenSession.has(sk)) {
        seenSession.add(sk);
        issues.push({
          id: `session:${sk}`,
          kind: "session_missing_rate",
          section: kick ? "kickbox" : "standard",
          severity: "error",
          params: {
            date: formatISODatePricing(date, language),
            dateIso: date,
            capacity: String(cap),
            rateType: kick ? "kickbox" : "standard",
          },
          fix: {
            type: "add_rate",
            section: kick ? "kickbox" : "standard",
            maxParticipants: cap,
            effectiveFrom: date,
            isKickbox: kick,
          },
        });
      }
    }
    if (issues.length >= maxIssues) return collapsePricingIssuesByEarliestDate(issues);
  }

  const { data: regs } = await supabase
    .from("session_registrations")
    .select(
      "session_id, user_id, training_sessions!inner(session_date, max_participants, is_kickbox, custom_slot_price_ils), profiles(full_name)"
    )
    .eq("status", "active");

  const { data: manuals } = await supabase
    .from("session_manual_participants")
    .select(
      "session_id, manual_participant_id, training_sessions!inner(session_date, max_participants, is_kickbox, custom_slot_price_ils), manual_participants(full_name)"
    );

  const regRows: RegistrationAuditRow[] = [];
  for (const r of (regs ?? []) as {
    session_id: string;
    user_id: string;
    training_sessions: SessionAuditRow | SessionAuditRow[];
    profiles: { full_name: string } | { full_name: string }[] | null;
  }[]) {
    const sess = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
    if (!sess || sess.session_date < start || sess.session_date > end) continue;
    const prof = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    regRows.push({
      session_id: r.session_id,
      user_id: r.user_id,
      manual_participant_id: null,
      session_date: sess.session_date,
      max_participants: sess.max_participants,
      is_kickbox: sess.is_kickbox,
      custom_slot_price_ils: sess.custom_slot_price_ils,
      athlete_name: prof?.full_name?.trim() || "—",
    });
  }
  for (const r of (manuals ?? []) as {
    session_id: string;
    manual_participant_id: string;
    training_sessions: SessionAuditRow | SessionAuditRow[];
    manual_participants: { full_name: string } | { full_name: string }[] | null;
  }[]) {
    const sess = Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions;
    if (!sess || sess.session_date < start || sess.session_date > end) continue;
    const mp = Array.isArray(r.manual_participants) ? r.manual_participants[0] : r.manual_participants;
    regRows.push({
      session_id: r.session_id,
      user_id: null,
      manual_participant_id: r.manual_participant_id,
      session_date: sess.session_date,
      max_participants: sess.max_participants,
      is_kickbox: sess.is_kickbox,
      custom_slot_price_ils: sess.custom_slot_price_ils,
      athlete_name: mp?.full_name?.trim() || "—",
    });
  }

  for (const r of regRows) {
    if (r.custom_slot_price_ils != null && Number.isFinite(Number(r.custom_slot_price_ils))) continue;
    const cap = r.max_participants;
    const date = r.session_date;
    const kick = !!r.is_kickbox;
    const athleteTiers = athleteRows.filter(
      (row) =>
        (r.user_id && row.user_id === r.user_id) ||
        (r.manual_participant_id && row.manual_participant_id === r.manual_participant_id)
    );
    let price =
      resolveTierPriceForDate(athleteTiers, cap, date) ??
      (kick
        ? resolveTierPriceForDate(kickboxRows, cap, date)
        : resolveTierPriceForDate(globalRows, cap, date));
    if (price != null) continue;

    const key = `${r.user_id ?? ""}:${r.manual_participant_id ?? ""}:${r.session_id}`;
    if (seenAthlete.has(key)) continue;
    seenAthlete.add(key);

    const athletePeriods = athleteTiers.filter((t) => t.max_participants === cap);
    const hasAthleteTier = athletePeriods.length > 0;
    issues.push({
      id: `athlete-bill:${key}`,
      kind: "athlete_billing_gap",
      section: "athlete",
      severity: "error",
      params: {
        athleteName: r.athlete_name,
        date: formatISODatePricing(date, language),
        dateIso: date,
        capacity: String(cap),
      },
      fix: hasAthleteTier
        ? athletePeriods[0]?.id
          ? { type: "edit_rate", rateId: athletePeriods[0].id!, section: "athlete" }
          : undefined
        : {
            type: "add_rate",
            section: "athlete",
            maxParticipants: cap,
            effectiveFrom: date,
            userId: r.user_id ?? undefined,
            manualParticipantId: r.manual_participant_id ?? undefined,
            athleteLabel: r.athlete_name,
          },
    });
    if (issues.length >= maxIssues) return collapsePricingIssuesByEarliestDate(issues);
  }

  return collapsePricingIssuesByEarliestDate(issues);
}

export async function auditCoachSessionPricingIssues(args: {
  supabase: SupabaseClient;
  coachId: string;
  coachRows: PricingRateTierRow[];
  language: LanguageCode;
  pastDays?: number;
  futureDays?: number;
  maxIssues?: number;
}): Promise<PricingIssue[]> {
  const { supabase, coachId, coachRows, language, pastDays = 30, futureDays = 120, maxIssues = 20 } = args;
  const today = toISODateLocal(new Date());
  const start = addDaysToISODate(today, -pastDays);
  const end = addDaysToISODate(today, futureDays);

  const { data, error } = await supabase
    .from("training_sessions")
    .select("id, session_date, max_participants")
    .eq("coach_id", coachId)
    .gte("session_date", start)
    .lte("session_date", end)
    .order("session_date", { ascending: true });

  if (error || !data?.length) return [];

  const sessionList = data as { id: string; session_date: string; max_participants: number }[];
  const sessionIds = sessionList.map((s) => s.id);
  const tierBySession = new Map<string, number>();

  const [{ data: regs }, { data: manuals }] = await Promise.all([
    supabase.from("session_registrations").select("session_id").in("session_id", sessionIds).eq("status", "active"),
    supabase.from("session_manual_participants").select("session_id").in("session_id", sessionIds),
  ]);

  for (const id of sessionIds) tierBySession.set(id, 0);
  for (const r of (regs ?? []) as { session_id: string }[]) {
    tierBySession.set(r.session_id, (tierBySession.get(r.session_id) ?? 0) + 1);
  }
  for (const r of (manuals ?? []) as { session_id: string }[]) {
    tierBySession.set(r.session_id, (tierBySession.get(r.session_id) ?? 0) + 1);
  }

  const issues: PricingIssue[] = [];
  const byTier = new Map<number, { session_date: string }>();

  for (const s of sessionList) {
    const tier = tierBySession.get(s.id) ?? 0;
    if (tier < 1) continue;

    const price = resolveTierPriceForDate(coachRows, tier, s.session_date);
    if (price != null && price > 0) continue;

    const prev = byTier.get(tier);
    if (!prev || s.session_date < prev.session_date) {
      byTier.set(tier, { session_date: s.session_date });
    }
  }

  for (const [tier, { session_date }] of byTier) {
    issues.push({
      id: `coach-session:${tier}:${session_date}`,
      kind: "coach_session_missing",
      section: "coach",
      severity: "error",
      params: {
        date: formatISODatePricing(session_date, language),
        dateIso: session_date,
        registered: String(tier),
      },
      fix: {
        type: "add_rate",
        section: "coach",
        maxParticipants: tier,
        effectiveFrom: session_date,
        coachId,
      },
    });
    if (issues.length >= maxIssues) return issues;
  }

  return issues;
}

/** Same problem type (ignoring which calendar day it was detected on). */
function pricingIssueDedupeKey(issue: PricingIssue): string {
  const p = issue.params;
  return [
    issue.kind,
    issue.section,
    p.context ?? "",
    p.capacity ?? "",
    p.registered ?? "",
    p.athleteName ?? "",
    p.rateType ?? "",
    p.gapRange ?? "",
    p.rangeA ?? "",
    p.rangeB ?? "",
  ].join("\0");
}

function issueSortDate(issue: PricingIssue): string {
  return issue.params.dateIso ?? "9999-12-31";
}

/** When the same issue repeats on multiple dates, keep only the earliest. */
export function collapsePricingIssuesByEarliestDate(issues: PricingIssue[]): PricingIssue[] {
  const groups = new Map<string, PricingIssue[]>();
  for (const issue of issues) {
    const key = pricingIssueDedupeKey(issue);
    const list = groups.get(key) ?? [];
    list.push(issue);
    groups.set(key, list);
  }
  const out: PricingIssue[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    let earliest = list[0]!;
    let earliestIso = issueSortDate(earliest);
    for (let i = 1; i < list.length; i++) {
      const cand = list[i]!;
      const iso = issueSortDate(cand);
      if (iso < earliestIso) {
        earliest = cand;
        earliestIso = iso;
      }
    }
    out.push(earliest);
  }
  return out;
}

/** Dedupe by id, collapse same issue across dates (earliest wins), then sort. */
export function mergePricingIssues(...groups: PricingIssue[][]): PricingIssue[] {
  const map = new Map<string, PricingIssue>();
  for (const g of groups) {
    for (const issue of g) {
      map.set(issue.id, issue);
    }
  }
  const order: PricingIssueSection[] = ["standard", "kickbox", "athlete", "coach"];
  const merged = collapsePricingIssuesByEarliestDate([...map.values()]);
  return merged.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return order.indexOf(a.section) - order.indexOf(b.section);
  });
}

export function filterPricingIssuesBySection(
  issues: PricingIssue[],
  sections: PricingIssueSection[]
): PricingIssue[] {
  const set = new Set(sections);
  return issues.filter((i) => set.has(i.section));
}
