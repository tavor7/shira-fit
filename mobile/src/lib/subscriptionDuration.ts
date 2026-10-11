/**
 * Predefined subscription durations (1 / 3 / 6 / 12 months) for the manager's "new subscription" form.
 *
 * Calendar months, never 30-day approximations, and aligned with the billing engine so a preset never adds a stray
 * charge: a subscription bills once per cycle starting on its plan start, then on the anchor day of every following
 * month (public.subscription_next_anchor_date: the next month, on min(anchor_day, last day of that month)); the anchor
 * day defaults to the start date's day (create_subscription). plan_end_date is INCLUSIVE (coverage runs while
 * session_date <= plan_end_date, and billing stops once a cycle would start after it). So "N months" ends on the day
 * before the N-th anchor date: exactly N full monthly cycles, e.g. Jan 31 + 1 month -> Feb 27 (the next cycle starts on
 * Feb 28), Jan 15 + 1 month -> Feb 14.
 *
 * Choosing a duration only fills in the end date: billing stays monthly (the price field is a monthly price). Dates are
 * plain ISO calendar dates (YYYY-MM-DD) handled in UTC arithmetic, so no device timezone can shift a day; "today" for
 * the default start date comes from studioTodayIso (Asia/Jerusalem).
 */

export const SUBSCRIPTION_DURATION_MONTHS = [1, 3, 6, 12] as const;
export type SubscriptionDurationMonths = (typeof SUBSCRIPTION_DURATION_MONTHS)[number];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = ISO_RE.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Mirrors public.subscription_next_anchor_date(anchor_day, from_date). */
export function nextAnchorDate(anchorDay: number, fromIso: string): string | null {
  const from = parseIso(fromIso);
  if (!from || !Number.isFinite(anchorDay)) return null;
  const y = from.m === 12 ? from.y + 1 : from.y;
  const m = from.m === 12 ? 1 : from.m + 1;
  const day = Math.min(Math.max(Math.trunc(anchorDay), 1), daysInMonth(y, m));
  return toIso(y, m, day);
}

/** Inclusive end date for a preset: the day before the `months`-th billing anchor after `startIso`. */
export function endDateForDuration(startIso: string, months: number, anchorDay?: number): string | null {
  const start = parseIso(startIso);
  if (!start || !Number.isInteger(months) || months < 1) return null;
  const anchor = anchorDay ?? start.d;
  let cur = startIso;
  for (let i = 0; i < months; i++) {
    const next = nextAnchorDate(anchor, cur);
    if (!next) return null;
    cur = next;
  }
  const last = parseIso(cur)!;
  return toIso(last.y, last.m, last.d - 1);
}

/** Which preset (if any) produces exactly this end date for this start date — "Custom" when none does. */
export function durationMatchingEndDate(startIso: string, endIso: string, anchorDay?: number): SubscriptionDurationMonths | null {
  for (const months of SUBSCRIPTION_DURATION_MONTHS) {
    if (endDateForDuration(startIso, months, anchorDay) === endIso) return months;
  }
  return null;
}
