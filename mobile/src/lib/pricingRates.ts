import type { LanguageCode } from "../i18n/translations";
import { formatISODatePricing, isValidISODateString, parseISODateLocal, toISODateLocal } from "./isoDate";

export type PricingRatePeriod = {
  id?: string;
  effective_from?: string;
  effective_to?: string | null;
};

export type PricingRateTierRow = PricingRatePeriod & {
  max_participants: number;
  price_ils: number | string;
};

const OPEN_END = "9999-12-31";

export function pricingOpenEnd(to: string | null | undefined): string {
  return to?.trim() ? to.trim() : OPEN_END;
}

export function pricingRangesOverlap(
  a: { effective_from?: string; effective_to?: string | null },
  b: { effective_from?: string; effective_to?: string | null }
): boolean {
  const aFrom = a.effective_from ?? "";
  const bFrom = b.effective_from ?? "";
  if (!aFrom || !bFrom) return false;
  return aFrom <= pricingOpenEnd(b.effective_to) && bFrom <= pricingOpenEnd(a.effective_to);
}

export function pricingActiveOnDate(
  effectiveFrom: string,
  effectiveTo: string | null | undefined,
  asOf: string
): boolean {
  if (!isValidISODateString(effectiveFrom) || !isValidISODateString(asOf)) return false;
  if (effectiveTo?.trim() && !isValidISODateString(effectiveTo)) return false;
  return effectiveFrom <= asOf && asOf <= pricingOpenEnd(effectiveTo);
}

export function formatPricingEffectiveRange(
  from: string,
  to: string | null | undefined,
  language: LanguageCode,
  presentLabel?: string
): string {
  const fromLabel = isValidISODateString(from) ? formatISODatePricing(from, language) : from;
  const openEnded =
    presentLabel ?? (language === "he" ? "עד היום" : "present");
  const toLabel =
    to?.trim() && isValidISODateString(to)
      ? formatISODatePricing(to, language)
      : openEnded;
  return `${fromLabel} – ${toLabel}`;
}

export function validatePricingPeriodInput(
  fromRaw: string,
  toRaw: string
): { ok: true; effective_from: string; effective_to: string | null } | { ok: false; errorKey: string } {
  const from = fromRaw.trim();
  const to = toRaw.trim();
  if (!isValidISODateString(from)) {
    return { ok: false, errorKey: "pricing.invalidPeriod" };
  }
  if (to && !isValidISODateString(to)) {
    return { ok: false, errorKey: "pricing.invalidPeriod" };
  }
  if (to && to < from) {
    return { ok: false, errorKey: "pricing.invalidPeriod" };
  }
  return { ok: true, effective_from: from, effective_to: to || null };
}

export function findPricingOverlap<T extends PricingRatePeriod & { max_participants?: number }>(
  candidate: PricingRatePeriod,
  existing: T[],
  opts?: { excludeId?: string; sameTier?: (row: T) => boolean }
): T | null {
  for (const row of existing) {
    if (opts?.excludeId && row.id === opts.excludeId) continue;
    if (opts?.sameTier && !opts.sameTier(row)) continue;
    if (pricingRangesOverlap(candidate, row)) return row;
  }
  return null;
}

export function isPricingOverlapDbError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("exclusion") || m.includes("overlap") || m.includes("conflicting key");
}

export function sortPricingRows<T extends { max_participants: number; effective_from?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.max_participants !== b.max_participants) return a.max_participants - b.max_participants;
    return (b.effective_from ?? "").localeCompare(a.effective_from ?? "");
  });
}

/** Pick active tier price for a session date from a list of dated tiers at one capacity. */
export function resolveTierPriceForDate(
  tiers: PricingRateTierRow[],
  cap: number,
  sessionDate: string
): number | null {
  const matches = tiers.filter(
    (t) =>
      t.max_participants === cap &&
      t.effective_from != null &&
      pricingActiveOnDate(t.effective_from, t.effective_to, sessionDate)
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
  const n = Number(matches[0].price_ils);
  return Number.isFinite(n) ? n : null;
}

export type PricingPeriodStatus = "current" | "upcoming" | "past";

export function pricingPeriodStatus(
  effectiveFrom: string | undefined,
  effectiveTo: string | null | undefined,
  asOf: string = toISODateLocal(new Date())
): PricingPeriodStatus | null {
  if (!effectiveFrom || !isValidISODateString(effectiveFrom) || !isValidISODateString(asOf)) return null;
  if (effectiveFrom > asOf) return "upcoming";
  if (effectiveTo?.trim() && isValidISODateString(effectiveTo) && effectiveTo < asOf) return "past";
  return "current";
}

export function groupPricingByCapacity<T extends PricingRateTierRow>(rows: T[]): { capacity: number; periods: T[] }[] {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const list = map.get(r.max_participants) ?? [];
    list.push(r);
    map.set(r.max_participants, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([capacity, periods]) => ({
      capacity,
      periods: [...periods].sort((x, y) => (y.effective_from ?? "").localeCompare(x.effective_from ?? "")),
    }));
}

export function splitPricingPeriods<T extends PricingRateTierRow>(
  periods: T[],
  asOf: string = toISODateLocal(new Date())
): { active: T[]; past: T[] } {
  const active: T[] = [];
  const past: T[] = [];
  for (const p of periods) {
    const status = p.effective_from ? pricingPeriodStatus(p.effective_from, p.effective_to, asOf) : "current";
    if (status === "past") past.push(p);
    else active.push(p);
  }
  const byFromDesc = (a: T, b: T) => (b.effective_from ?? "").localeCompare(a.effective_from ?? "");
  active.sort(byFromDesc);
  past.sort(byFromDesc);
  return { active, past };
}

/** Groups that have at least one current or upcoming period (ended-only tiers hidden from the main list). */
export function filterVisiblePricingGroups<T extends { periods: PricingRateTierRow[] }>(
  groups: T[]
): T[] {
  const asOf = toISODateLocal(new Date());
  return groups.filter((g) => splitPricingPeriods(g.periods, asOf).active.length > 0);
}

export type PricingListCluster<T extends PricingRateTierRow> = {
  clusterKey: string;
  title: string;
  items: PricingListRow<T>[];
  pastCount: number;
  pastPeriods: T[];
};

export function clusterPricingListRows<T extends PricingRateTierRow>(
  rows: PricingListRow<T>[],
  mode: "groupKey" | "title"
): PricingListCluster<T>[] {
  const map = new Map<string, PricingListRow<T>[]>();
  for (const row of rows) {
    const key = mode === "title" ? row.title : row.groupKey;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([clusterKey, items]) => {
    const pastPeriods: T[] = [];
    const seenPast = new Set<string>();
    for (const item of items) {
      for (const p of item.pastPeriods) {
        const pk = p.id ?? `past-${p.effective_from}-${p.max_participants}`;
        if (!seenPast.has(pk)) {
          seenPast.add(pk);
          pastPeriods.push(p);
        }
      }
    }
    const pastCount = pastPeriods.length;
    return {
      clusterKey,
      title: items[0]?.title ?? clusterKey,
      items,
      pastCount,
      pastPeriods,
    };
  });
}

export type PricingListRow<T extends PricingRateTierRow> = {
  key: string;
  title: string;
  subtitle?: string;
  period: T;
  pastCount: number;
  pastPeriods: T[];
  groupKey: string;
};

/** Flat list rows for pricing sections — one row per active period. */
export function flattenPricingGroupsForList<T extends PricingRateTierRow>(
  groups: { capacity: number; label?: string; periods: T[] }[],
  formatCapacityTitle: (capacity: number) => string
): PricingListRow<T>[] {
  const asOf = toISODateLocal(new Date());
  const out: PricingListRow<T>[] = [];
  for (const g of groups) {
    const { active, past } = splitPricingPeriods(g.periods, asOf);
    if (active.length === 0) continue;
    const groupKey = g.label ? `${g.label}:${g.capacity}` : String(g.capacity);
    const title = g.label ?? formatCapacityTitle(g.capacity);
    const subtitle = g.label ? formatCapacityTitle(g.capacity) : undefined;
    active.forEach((period, index) => {
      out.push({
        key: period.id ?? `${groupKey}-${period.effective_from}`,
        title,
        subtitle,
        period,
        pastCount: index === 0 ? past.length : 0,
        pastPeriods: index === 0 ? past : [],
        groupKey,
      });
    });
  }
  return out;
}

export function pickFeaturedPricingPeriod<T extends PricingRateTierRow>(
  periods: T[],
  asOf: string = toISODateLocal(new Date())
): T | null {
  if (periods.length === 0) return null;
  const current = periods.find(
    (p) => p.effective_from && pricingPeriodStatus(p.effective_from, p.effective_to, asOf) === "current"
  );
  if (current) return current;
  const upcoming = [...periods]
    .filter((p) => p.effective_from && pricingPeriodStatus(p.effective_from, p.effective_to, asOf) === "upcoming")
    .sort((a, b) => (a.effective_from ?? "").localeCompare(b.effective_from ?? ""));
  if (upcoming[0]) return upcoming[0];
  return periods[0] ?? null;
}

export type AthletePricingGroup<T extends PricingRateTierRow> = {
  key: string;
  label: string;
  capacity: number;
  periods: T[];
};

export function groupAthletePricingRows<T extends PricingRateTierRow & {
  user_id?: string | null;
  manual_participant_id?: string | null;
}>(
  rows: T[],
  getLabel: (row: T) => string
): AthletePricingGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const payee = r.manual_participant_id ?? r.user_id ?? "";
    const key = `${payee}:${r.max_participants}`;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(([key, periods]) => {
      const sorted = [...periods].sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
      const cap = sorted[0]?.max_participants ?? 0;
      return { key, label: getLabel(sorted[0]!), capacity: cap, periods: sorted };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.capacity - b.capacity);
}
