import {
  attStatusFromRow,
  attStatusLabel,
  computeBillingSummary,
  mergedHistorySections,
  parseMoney,
} from "./participantHistoryHelpers";
import type { AthleteFamily } from "./athleteFamilies";
import type { PricingRateTierRow } from "./pricingRates";
import type { AthleteAccountPayment, ParticipantHistoryRow } from "../types/database";

function makeRow(overrides: Partial<ParticipantHistoryRow> = {}): ParticipantHistoryRow {
  return {
    registration_id: "reg-1",
    athlete_user_id: "user-1",
    athlete_name: "Dana Cohen",
    athlete_phone: "0500000000",
    session_id: "sess-1",
    session_date: "2026-07-13",
    start_time: "18:00",
    duration_minutes: 60,
    max_participants: 4,
    reg_status: "active",
    registered_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function makePayment(overrides: Partial<AthleteAccountPayment> = {}): AthleteAccountPayment {
  return {
    id: "pay-1",
    payee_id: "user-1",
    payee_is_manual: false,
    amount_ils: 100,
    payment_method: "cash",
    note: null,
    payer_name: null,
    paid_at: "2026-07-05T00:00:00Z",
    created_at: "2026-07-05T00:00:00Z",
    created_by: null,
    ...overrides,
  };
}

const t = (key: string) => key;

describe("parseMoney", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("parses numbers and numeric strings", () => {
    expect(parseMoney(42)).toBe(42);
    expect(parseMoney("42.5")).toBe(42.5);
  });

  it("returns null for non-numeric input", () => {
    expect(parseMoney("abc")).toBeNull();
  });
});

describe("attStatusFromRow", () => {
  it("maps attended true/false/null to arrived/absent/unset", () => {
    expect(attStatusFromRow(makeRow({ attended: true }))).toBe("arrived");
    expect(attStatusFromRow(makeRow({ attended: false }))).toBe("absent");
    expect(attStatusFromRow(makeRow({ attended: null }))).toBe("unset");
    expect(attStatusFromRow(makeRow({}))).toBe("unset");
  });
});

describe("attStatusLabel", () => {
  it("returns the translation key for each status", () => {
    expect(attStatusLabel("arrived", t)).toBe("participantHistory.attendanceArrived");
    expect(attStatusLabel("absent", t)).toBe("participantHistory.attendanceAbsent");
    expect(attStatusLabel("unset", t)).toBe("participantHistory.attendanceNotSet");
  });
});

describe("mergedHistorySections", () => {
  it("merges sessions and payments into one section sorted by date descending", () => {
    const rows = [makeRow({ registration_id: "r1", session_date: "2026-07-01" })];
    const payments = [makePayment({ id: "p1", paid_at: "2026-07-10" })];
    const [section] = mergedHistorySections(rows, payments, "Dana Cohen");
    expect(section!.data.map((d) => d.kind)).toEqual(["payment", "session"]);
  });

  it("uses the family name as title when a family context is provided", () => {
    const family: AthleteFamily = { id: "fam-1", name: "Cohen Family", members: [] };
    const [section] = mergedHistorySections([], [], "fallback", family);
    expect(section!.title).toBe("Cohen Family");
  });

  it("falls back to the athlete label when there are no rows and no family context", () => {
    const [section] = mergedHistorySections([], [], "  Dana Cohen  ");
    expect(section!.title).toBe("Dana Cohen");
  });

  it("uses the first row's name/phone as title when rows exist but no family context", () => {
    const rows = [makeRow({ athlete_name: "Dana Cohen", athlete_phone: "0500000000" })];
    const [section] = mergedHistorySections(rows, [], "ignored");
    expect(section!.title).toBe("Dana Cohen · 0500000000");
  });
});

describe("computeBillingSummary", () => {
  const globalTiers: PricingRateTierRow[] = [
    { max_participants: 4, price_ils: 100, effective_from: "2026-01-01", effective_to: null },
  ];

  it("sums received amounts from session payments and account payments", () => {
    const regs = [makeRow({ amount_paid: 50, payment_method: "cash" })];
    const payments = [makePayment({ amount_ils: 30, payment_method: "paybox" })];
    const summary = computeBillingSummary(regs, payments, [], [], [], {}, {});
    expect(summary.received).toBe(80);
    expect(summary.byMethod).toEqual(
      expect.arrayContaining([
        { key: "cash", total: 50 },
        { key: "paybox", total: 30 },
      ])
    );
  });

  it("counts expected billing for owed sessions using the global tier price", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {});
    expect(summary.expected).toBe(100);
    expect(summary.missingRuleCount).toBe(0);
  });

  it("increments missingRuleCount when no tier price resolves for an owed session", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 9 })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {});
    expect(summary.expected).toBe(0);
    expect(summary.missingRuleCount).toBe(1);
  });

  it("does not count a session as owed when not attended and no no-show charge", () => {
    const regs = [makeRow({ reg_status: "active", attended: false, charge_no_show: false })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {});
    expect(summary.expected).toBe(0);
    expect(summary.missingRuleCount).toBe(0);
  });

  it("counts a late-cancellation charge as owed", () => {
    const regs = [
      makeRow({
        reg_status: "cancelled",
        cancellation_within_12h: true,
        cancellation_charged: true,
        max_participants: 4,
      }),
    ];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {});
    expect(summary.expected).toBe(100);
  });

  it("adds a collected cancellation penalty to received, grouped as 'other'", () => {
    const regs = [makeRow({ cancellation_penalty_collected: 60 })];
    const summary = computeBillingSummary(regs, [], [], [], [], {}, {});
    expect(summary.received).toBe(60);
    expect(summary.byMethod).toContainEqual({ key: "other", total: 60 });
  });

  it("computes balance as expected minus received", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4, amount_paid: 40 })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {});
    expect(summary.balance).toBe(60);
  });
});
