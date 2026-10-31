import {
  currentWeekStartIso,
  isStaffWeekLoaded,
  needsEarlierStaffRange,
  staffCalendarFromDate,
} from "./staffCalendarRange";

// Wednesday 2026-11-04, 09:30 local.
const NOW = new Date(2026, 10, 4, 9, 30);

describe("staffCalendarRange", () => {
  it("uses the calendar's Sunday-based week", () => {
    expect(currentWeekStartIso(NOW)).toBe("2026-11-01");
    expect(currentWeekStartIso(new Date(2026, 10, 1, 0, 5))).toBe("2026-11-01");
    expect(currentWeekStartIso(new Date(2026, 10, 7, 23, 55))).toBe("2026-11-01");
  });

  it("loads the current week onward plus one buffer week by default", () => {
    expect(staffCalendarFromDate("", NOW)).toBe("2026-10-25");
    expect(staffCalendarFromDate("2026-11-01", NOW)).toBe("2026-10-25");
  });

  it("never starts after the current week when a future week is visible (alerts need the current week)", () => {
    expect(staffCalendarFromDate("2026-11-15", NOW)).toBe("2026-10-25");
  });

  it("starts one week before a visible past week", () => {
    expect(staffCalendarFromDate("2026-09-06", NOW)).toBe("2026-08-30");
  });

  it("crosses month and year boundaries", () => {
    expect(staffCalendarFromDate("2026-01-04", NOW)).toBe("2025-12-28");
  });

  it("knows whether the visible week is loaded", () => {
    expect(isStaffWeekLoaded("2026-11-01", null)).toBe(false);
    expect(isStaffWeekLoaded("", "2026-10-25")).toBe(true);
    expect(isStaffWeekLoaded("2026-11-01", "2026-10-25")).toBe(true);
    expect(isStaffWeekLoaded("2026-10-25", "2026-10-25")).toBe(true);
    expect(isStaffWeekLoaded("2026-10-18", "2026-10-25")).toBe(false);
  });

  it("prefetches when the buffer week is visible and loads when an unloaded week is visible", () => {
    expect(needsEarlierStaffRange("2026-11-01", "2026-10-25")).toBe(false);
    expect(needsEarlierStaffRange("2026-10-25", "2026-10-25")).toBe(true);
    expect(needsEarlierStaffRange("2026-10-04", "2026-10-25")).toBe(true);
    expect(needsEarlierStaffRange("2026-10-25", null)).toBe(false);
    expect(needsEarlierStaffRange("", "2026-10-25")).toBe(false);
    // After the range is extended for a visible week, that week no longer asks for more (no load loop).
    const from = staffCalendarFromDate("2026-10-25", NOW);
    expect(needsEarlierStaffRange("2026-10-25", from)).toBe(false);
  });
});
