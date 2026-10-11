import { groupImpactByDate, impactItemKey } from "./subscriptionImpactDetails";

jest.mock("./supabase", () => ({ supabase: {} }));

describe("subscription impact presentation (Phase 5 / S)", () => {
  it("keys registrations and manual participants apart", () => {
    expect(impactItemKey({ registration_id: "a", manual_participant_id: null })).toBe("r:a");
    expect(impactItemKey({ registration_id: null, manual_participant_id: "a" })).toBe("m:a");
  });

  it("groups same-day sessions under one date, ordered by time", () => {
    const rows = [
      { id: "3", session_date: "2026-10-12" },
      { id: "1", session_date: "2026-10-11" },
      { id: "2", session_date: "2026-10-11" },
    ];
    const times: Record<string, string | null> = { "1": "18:00", "2": "07:00", "3": null };
    const groups = groupImpactByDate(rows, (r) => times[r.id]);
    expect(groups.map((g) => [g.date, g.items.map((i) => i.id)])).toEqual([
      ["2026-10-11", ["2", "1"]],
      ["2026-10-12", ["3"]],
    ]);
  });
});
