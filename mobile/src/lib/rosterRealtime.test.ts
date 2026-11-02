import { rosterChangesAreNews, type RosterRowState } from "./rosterRealtime";
import type { RealtimeChange } from "../hooks/useRealtimeRefetch";

const shown: RosterRowState[] = [
  { id: "u:a", attended: false, chargeNoShow: false, paymentMethod: null, amountPaid: null },
  { id: "u:b", attended: true, chargeNoShow: false, paymentMethod: "cash", amountPaid: 60 },
  { id: "m:w", attended: null, chargeNoShow: false, paymentMethod: null, amountPaid: null },
];
const reg = (n: Record<string, unknown>): RealtimeChange => ({ table: "session_registrations", eventType: "UPDATE", new: n });

describe("rosterChangesAreNews", () => {
  it("the echo of our own attendance write is not news", () => {
    expect(rosterChangesAreNews([reg({ user_id: "a", status: "active", attended: false, charge_no_show: false, payment_method: null, amount_paid: null })], shown)).toBe(false);
  });

  it("numeric amounts arrive as strings or numbers", () => {
    expect(rosterChangesAreNews([reg({ user_id: "b", status: "active", attended: true, charge_no_show: false, payment_method: "cash", amount_paid: "60.00" })], shown)).toBe(false);
  });

  it("any shown field that differs is news (someone else changed it)", () => {
    expect(rosterChangesAreNews([reg({ user_id: "a", status: "active", attended: true, charge_no_show: false, payment_method: null, amount_paid: null })], shown)).toBe(true);
    expect(rosterChangesAreNews([reg({ user_id: "b", status: "active", attended: true, charge_no_show: false, payment_method: "bit", amount_paid: 60 })], shown)).toBe(true);
    expect(rosterChangesAreNews([reg({ user_id: "b", status: "active", attended: true, charge_no_show: false, payment_method: "cash", amount_paid: 70 })], shown)).toBe(true);
    expect(rosterChangesAreNews([reg({ user_id: "a", status: "active", attended: false, charge_no_show: true, payment_method: null, amount_paid: null })], shown)).toBe(true);
  });

  it("status changes, inserts, deletes, unknown rows and cancellations are news", () => {
    expect(rosterChangesAreNews([reg({ user_id: "a", status: "cancelled", attended: false, charge_no_show: false })], shown)).toBe(true);
    expect(rosterChangesAreNews([{ table: "session_registrations", eventType: "INSERT", new: { user_id: "c", status: "active" } }], shown)).toBe(true);
    expect(rosterChangesAreNews([{ table: "session_manual_participants", eventType: "DELETE", new: null }], shown)).toBe(true);
    expect(rosterChangesAreNews([reg({ user_id: "zzz", status: "active", attended: null, charge_no_show: false })], shown)).toBe(true);
    expect(rosterChangesAreNews([{ table: "cancellations", eventType: "INSERT", new: { user_id: "a" } }], shown)).toBe(true);
  });

  it("walk-ins are compared by manual participant id", () => {
    const w = (n: Record<string, unknown>): RealtimeChange => ({ table: "session_manual_participants", eventType: "UPDATE", new: n });
    expect(rosterChangesAreNews([w({ manual_participant_id: "w", attended: null, charge_no_show: false, payment_method: null, amount_paid: null })], shown)).toBe(false);
    expect(rosterChangesAreNews([w({ manual_participant_id: "w", attended: true, charge_no_show: false, payment_method: null, amount_paid: null })], shown)).toBe(true);
  });

  it("unknown batches (missed while hidden) are always news; other tables are ignored", () => {
    expect(rosterChangesAreNews(null, shown)).toBe(true);
    expect(rosterChangesAreNews([{ table: "waitlist_requests", eventType: "INSERT", new: { user_id: "x" } }], shown)).toBe(false);
  });

  it("one news item in a batch is enough", () => {
    expect(
      rosterChangesAreNews(
        [
          reg({ user_id: "a", status: "active", attended: false, charge_no_show: false, payment_method: null, amount_paid: null }),
          reg({ user_id: "b", status: "active", attended: false, charge_no_show: false, payment_method: null, amount_paid: null }),
        ],
        shown
      )
    ).toBe(true);
  });
});
