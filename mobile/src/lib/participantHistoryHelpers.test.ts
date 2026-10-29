import {
  attStatusFromRow,
  attStatusLabel,
  computeBillingSummary,
  mergedHistorySections,
  parseMoney,
  rosterOverrideKey,
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
    const summary = computeBillingSummary(regs, payments, [], [], [], {}, {}, {}, () => false);
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
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(100);
    expect(summary.missingRuleCount).toBe(0);
  });

  it("increments missingRuleCount when no tier price resolves for an owed session", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 9 })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(0);
    expect(summary.missingRuleCount).toBe(1);
  });

  it("does not count a session as owed when not attended and no no-show charge", () => {
    const regs = [makeRow({ reg_status: "active", attended: false, charge_no_show: false })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {}, {}, () => false);
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
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(100);
  });

  it("adds a collected cancellation penalty to received, grouped as 'other' when no payment method was recorded", () => {
    const regs = [makeRow({ cancellation_penalty_collected: 60 })];
    const summary = computeBillingSummary(regs, [], [], [], [], {}, {}, {}, () => false);
    expect(summary.received).toBe(60);
    expect(summary.byMethod).toContainEqual({ key: "other", total: 60 });
  });

  it("groups a collected cancellation penalty by its actual recorded payment method, not always 'other'", () => {
    const regs = [makeRow({ cancellation_penalty_collected: 60, cancellation_payment_method: "cash" })];
    const summary = computeBillingSummary(regs, [], [], [], [], {}, {}, {}, () => false);
    expect(summary.received).toBe(60);
    expect(summary.byMethod).toContainEqual({ key: "cash", total: 60 });
    expect(summary.byMethod).not.toContainEqual({ key: "other", total: 60 });
  });

  it("computes balance as expected minus received", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4, amount_paid: 40 })];
    const summary = computeBillingSummary(regs, [], globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.balance).toBe(60);
  });

  it("a discount account payment reduces expected instead of adding to received, and is reported separately rather than as a payment method", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const payments = [makePayment({ amount_ils: 50, payment_method: "discount" })];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(50); // 100 owed - 50 discount
    expect(summary.received).toBe(0);
    expect(summary.balance).toBe(50);
    expect(summary.discountTotal).toBe(50);
    expect(summary.byMethod).toEqual([]);
  });

  it("excludes a reversed discount from discountTotal, same as any other reversed payment", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const payments = [
      makePayment({ amount_ils: 50, payment_method: "discount", reversed_at: "2026-07-14T00:00:00Z" }),
    ];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.discountTotal).toBe(0);
    expect(summary.expected).toBe(100);
  });

  it("reconciles: byMethod sums to received even with a mix of real payments, a discount, and a cancellation penalty", () => {
    const regs = [
      makeRow({
        reg_status: "active",
        attended: true,
        max_participants: 4,
        amount_paid: 40,
        payment_method: "cash",
      }),
      makeRow({ registration_id: "reg-2", cancellation_penalty_collected: 20, cancellation_payment_method: "card" }),
    ];
    const payments = [
      makePayment({ amount_ils: 30, payment_method: "card" }),
      makePayment({ amount_ils: 25, payment_method: "discount" }),
    ];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.received).toBe(90); // 40 cash + 30 card + 20 penalty, discount excluded
    expect(summary.discountTotal).toBe(25);
    const byMethodSum = summary.byMethod.reduce((sum, m) => sum + m.total, 0);
    expect(byMethodSum).toBe(summary.received);
    expect(summary.byMethod).toContainEqual({ key: "cash", total: 40 });
    expect(summary.byMethod).toContainEqual({ key: "card", total: 50 });
    expect(summary.byMethod.find((m) => m.key === "discount")).toBeUndefined();
  });

  it("a discount matching the full owed amount zeroes the balance", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const payments = [makePayment({ amount_ils: 100, payment_method: "discount" })];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(0);
    expect(summary.received).toBe(0);
    expect(summary.balance).toBe(0);
  });

  it("clamps expected at 0 when the discount exceeds what was owed", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const payments = [makePayment({ amount_ils: 150, payment_method: "discount" })];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.expected).toBe(0);
    expect(summary.balance).toBe(0);
  });

  it("uses a per-participant roster rate override instead of the tier price when set", () => {
    const regs = [
      makeRow({ session_id: "sess-1", athlete_user_id: "user-1", reg_status: "active", attended: true, max_participants: 4 }),
    ];
    const rosterPriceByKey = { [rosterOverrideKey("sess-1", false, "user-1")]: 60 };
    const summary = computeBillingSummary(
      regs,
      [],
      globalTiers,
      [],
      [],
      {},
      {},
      rosterPriceByKey,
      () => false
    );
    expect(summary.expected).toBe(60);
  });

  it("does not charge a session covered by an active subscription", () => {
    const regs = [
      makeRow({ registration_id: "reg-covered", reg_status: "active", attended: true, max_participants: 4 }),
    ];
    const summary = computeBillingSummary(
      regs,
      [],
      globalTiers,
      [],
      [],
      {},
      {},
      {},
      () => false,
      undefined,
      undefined,
      new Set(["reg-covered"])
    );
    expect(summary.expected).toBe(0);
    expect(summary.missingRuleCount).toBe(0);
  });

  it("adds net subscription charges for the period to expected", () => {
    const summary = computeBillingSummary(
      [],
      [],
      [],
      [],
      [],
      {},
      {},
      {},
      () => false,
      undefined,
      undefined,
      undefined,
      360
    );
    expect(summary.expected).toBe(360);
    expect(summary.subscriptionChargesIls).toBe(360);
    expect(summary.balance).toBe(360);
  });

  it("nets a reversed subscription charge (e.g. cancellation) to zero expected", () => {
    const summary = computeBillingSummary(
      [],
      [],
      [],
      [],
      [],
      {},
      {},
      {},
      () => false,
      undefined,
      undefined,
      undefined,
      0 // +360 recurring, -360 reversal already netted by the caller
    );
    expect(summary.expected).toBe(0);
  });

  it("excludes a reversed account payment from received", () => {
    const regs = [makeRow({ reg_status: "active", attended: true, max_participants: 4 })];
    const payments = [
      makePayment({ amount_ils: 100, payment_method: "cash", reversed_at: "2026-07-06T00:00:00Z" }),
    ];
    const summary = computeBillingSummary(regs, payments, globalTiers, [], [], {}, {}, {}, () => false);
    expect(summary.received).toBe(0);
    expect(summary.byMethod).toEqual([]);
    expect(summary.balance).toBe(100);
  });

  it("a covered session plus its subscription charge produces no double-counting", () => {
    const regs = [
      makeRow({ registration_id: "reg-covered", reg_status: "active", attended: true, max_participants: 4 }),
    ];
    const payments = [makePayment({ amount_ils: 360, payment_method: "cash" })];
    const summary = computeBillingSummary(
      regs,
      payments,
      globalTiers,
      [],
      [],
      {},
      {},
      {},
      () => false,
      undefined,
      undefined,
      new Set(["reg-covered"]),
      360
    );
    // Session (worth 100 by tier) owes nothing — the subscription charge (360) is the
    // only debt line — so expected is exactly the subscription charge, not 460.
    expect(summary.expected).toBe(360);
    expect(summary.received).toBe(360);
    expect(summary.balance).toBe(0);
  });

  it("scopes cleanly to whatever rows/payments are passed in, e.g. one athlete's or one date range's pre-filtered data, with no leakage between independent calls", () => {
    // ParticipantHistoryScreen filters rows/payments to one athlete and one date range
    // *before* calling this function, so computeBillingSummary itself must stay a pure
    // function of exactly what it's given — two separate scopes computed back to back
    // must not share any total.
    const athleteARegs = [makeRow({ athlete_user_id: "user-a", amount_paid: 40, payment_method: "cash" })];
    const athleteAPayments = [makePayment({ payee_id: "user-a", amount_ils: 20, payment_method: "discount" })];
    const athleteBRegs = [makeRow({ athlete_user_id: "user-b", amount_paid: 70, payment_method: "card" })];
    const athleteBPayments: AthleteAccountPayment[] = [];

    const summaryA = computeBillingSummary(athleteARegs, athleteAPayments, [], [], [], {}, {}, {}, () => false);
    const summaryB = computeBillingSummary(athleteBRegs, athleteBPayments, [], [], [], {}, {}, {}, () => false);

    expect(summaryA.received).toBe(40);
    expect(summaryA.discountTotal).toBe(20);
    expect(summaryB.received).toBe(70);
    expect(summaryB.discountTotal).toBe(0);
    expect(summaryB.byMethod).toEqual([{ key: "card", total: 70 }]);
  });
});
