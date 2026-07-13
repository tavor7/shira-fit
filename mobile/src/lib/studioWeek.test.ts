import {
  ATHLETE_BROWSE_MAX_WEEK_OFFSET,
  athleteBrowseWeekBounds,
  athleteBrowseWeekEnd,
  studioTodayIso,
  weekBoundsSunday,
} from "./studioWeek";

describe("studioTodayIso", () => {
  it("returns the calendar date in the studio timezone (Asia/Jerusalem), not UTC", () => {
    // 22:30 UTC on 2026-07-13 is 01:30 on 2026-07-14 in Asia/Jerusalem (UTC+3 in July) —
    // a naive UTC read would wrongly report the 13th.
    const now = new Date("2026-07-13T22:30:00Z");
    expect(studioTodayIso(now)).toBe("2026-07-14");
  });

  it("agrees with UTC when well within the same calendar day in both zones", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    expect(studioTodayIso(now)).toBe("2026-07-15");
  });
});

describe("weekBoundsSunday", () => {
  // 2000-01-01 is a known Saturday, so 2000-01-02 is a known Sunday.
  it("returns the same Sun–Sat range for every day within that week", () => {
    expect(weekBoundsSunday("2000-01-02")).toEqual({ start: "2000-01-02", end: "2000-01-08" }); // Sunday itself
    expect(weekBoundsSunday("2000-01-05")).toEqual({ start: "2000-01-02", end: "2000-01-08" }); // Wednesday
    expect(weekBoundsSunday("2000-01-08")).toEqual({ start: "2000-01-02", end: "2000-01-08" }); // Saturday
  });

  it("rolls over to the next week's bounds on the following Sunday", () => {
    expect(weekBoundsSunday("2000-01-09")).toEqual({ start: "2000-01-09", end: "2000-01-15" });
  });

  it("matches Postgres `_week_start_sunday` semantics across a month boundary", () => {
    // 2026-07-15 (Wed, studio-local) belongs to the Sun-Jul-12 .. Sat-Jul-18 week.
    expect(weekBoundsSunday("2026-07-15")).toEqual({ start: "2026-07-12", end: "2026-07-18" });
  });
});

describe("athleteBrowseWeekEnd", () => {
  it("is the Saturday of the week after the current studio week", () => {
    const now = new Date("2026-07-15T10:00:00Z"); // studio-local Wed 2026-07-15, week is Jul 12–18
    expect(athleteBrowseWeekEnd(now)).toBe("2026-07-25"); // Sat of the following week
  });
});

describe("athleteBrowseWeekBounds (deprecated)", () => {
  it("starts at this week's Sunday and ends at next week's Saturday", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    expect(athleteBrowseWeekBounds(now)).toEqual({ start: "2026-07-12", end: "2026-07-25" });
  });
});

describe("ATHLETE_BROWSE_MAX_WEEK_OFFSET", () => {
  it("is 1 (this week and next week only, no cap going backward)", () => {
    expect(ATHLETE_BROWSE_MAX_WEEK_OFFSET).toBe(1);
  });
});
