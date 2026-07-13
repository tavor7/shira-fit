import {
  addDaysToISODate,
  formatSessionStartTime,
  formatSessionTimeRange,
  getSessionTemporalPhase,
  hasSessionNotEnded,
  hasSessionNotStarted,
  isCancellationWithinHoursBeforeSession,
  isSessionInProgress,
  parseTimeToMinutes,
  sessionEndsAt,
  sessionStartsAt,
  suggestNextSessionStartTime,
} from "./sessionTime";

describe("parseTimeToMinutes", () => {
  it("parses HH:MM", () => {
    expect(parseTimeToMinutes("18:00")).toBe(18 * 60);
  });

  it("parses HH:MM:SS, ignoring seconds", () => {
    expect(parseTimeToMinutes("09:30:45")).toBe(9 * 60 + 30);
  });
});

describe("sessionStartsAt / sessionEndsAt", () => {
  it("builds a local Date from date + time with no timezone shift", () => {
    const start = sessionStartsAt("2026-07-13", "18:00");
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6); // 0-indexed: July
    expect(start.getDate()).toBe(13);
    expect(start.getHours()).toBe(18);
    expect(start.getMinutes()).toBe(0);
  });

  it("adds duration minutes to get the end instant", () => {
    const start = sessionStartsAt("2026-07-13", "18:00");
    const end = sessionEndsAt("2026-07-13", "18:00", 90);
    expect(end.getTime() - start.getTime()).toBe(90 * 60 * 1000);
  });
});

/**
 * Client-side mirror of the DB 24h late-cancel rule in
 * supabase/migrations/20250331210000_cancel_24h.sql:
 *   v_charged := (now() > v_start - interval '24 hours')
 * i.e. charged iff the cancel instant is strictly less than 24h before start.
 *
 * Note: the client function's boundary is inclusive (`<=`) while the DB's is
 * exclusive (`>`/strict). At exactly the 24h mark the two disagree by one
 * instant — the DB would NOT charge, the client WOULD report "charged".
 * Documented here as existing behavior; not changed as part of this test pass.
 */
describe("isCancellationWithinHoursBeforeSession", () => {
  const sessionDate = "2026-07-20";
  const startTime = "18:00"; // session starts 2026-07-20T18:00 local

  it("is not charged when cancelled well before the window (25h before start)", () => {
    const cancelledAt = new Date(2026, 6, 19, 17, 0, 0).toISOString(); // 25h before
    expect(isCancellationWithinHoursBeforeSession(sessionDate, startTime, cancelledAt, 24)).toBe(false);
  });

  it("is charged when cancelled just inside the window (1h before start)", () => {
    const cancelledAt = new Date(2026, 6, 20, 17, 0, 0).toISOString(); // 1h before
    expect(isCancellationWithinHoursBeforeSession(sessionDate, startTime, cancelledAt, 24)).toBe(true);
  });

  it("is charged exactly at the 24h boundary (inclusive on the client)", () => {
    const cancelledAt = new Date(2026, 6, 19, 18, 0, 0).toISOString(); // exactly 24h before
    expect(isCancellationWithinHoursBeforeSession(sessionDate, startTime, cancelledAt, 24)).toBe(true);
  });

  it("is not charged for a cancellation after the session has started", () => {
    const cancelledAt = new Date(2026, 6, 20, 18, 30, 0).toISOString(); // 30m after start
    expect(isCancellationWithinHoursBeforeSession(sessionDate, startTime, cancelledAt, 24)).toBe(false);
  });

  it("treats an unparseable cancellation timestamp as not charged", () => {
    expect(isCancellationWithinHoursBeforeSession(sessionDate, startTime, "not-a-date", 24)).toBe(false);
  });
});

describe("hasSessionNotStarted / hasSessionNotEnded / isSessionInProgress", () => {
  const sessionDate = "2026-07-20";
  const startTime = "18:00";
  const duration = 60;

  it("hasSessionNotStarted is true before start and false after", () => {
    const before = new Date(2026, 6, 20, 17, 59, 0);
    const after = new Date(2026, 6, 20, 18, 1, 0);
    expect(hasSessionNotStarted(sessionDate, startTime, before)).toBe(true);
    expect(hasSessionNotStarted(sessionDate, startTime, after)).toBe(false);
  });

  it("hasSessionNotEnded is true during the session and false after it ends", () => {
    const during = new Date(2026, 6, 20, 18, 30, 0);
    const after = new Date(2026, 6, 20, 19, 1, 0);
    expect(hasSessionNotEnded(sessionDate, startTime, duration, during)).toBe(true);
    expect(hasSessionNotEnded(sessionDate, startTime, duration, after)).toBe(false);
  });

  it("isSessionInProgress is only true within [start, end)", () => {
    const before = new Date(2026, 6, 20, 17, 59, 0);
    const during = new Date(2026, 6, 20, 18, 30, 0);
    const atEnd = new Date(2026, 6, 20, 19, 0, 0);
    expect(isSessionInProgress(sessionDate, startTime, duration, before)).toBe(false);
    expect(isSessionInProgress(sessionDate, startTime, duration, during)).toBe(true);
    expect(isSessionInProgress(sessionDate, startTime, duration, atEnd)).toBe(false);
  });
});

describe("getSessionTemporalPhase", () => {
  const sessionDate = "2026-07-20";
  const startTime = "18:00";

  it("returns upcoming, live, and past at the right instants", () => {
    expect(getSessionTemporalPhase(sessionDate, startTime, 60, new Date(2026, 6, 20, 17, 0))).toBe("upcoming");
    expect(getSessionTemporalPhase(sessionDate, startTime, 60, new Date(2026, 6, 20, 18, 30))).toBe("live");
    expect(getSessionTemporalPhase(sessionDate, startTime, 60, new Date(2026, 6, 20, 19, 30))).toBe("past");
  });

  it("falls back to a 60-minute duration when given a non-positive value", () => {
    const duringDefaultDuration = new Date(2026, 6, 20, 18, 30);
    expect(getSessionTemporalPhase(sessionDate, startTime, 0, duringDefaultDuration)).toBe("live");
  });
});

describe("suggestNextSessionStartTime", () => {
  it("returns the fallback when there are no existing start times", () => {
    expect(suggestNextSessionStartTime([])).toBe("18:00");
  });

  it("returns one hour after the latest existing start time", () => {
    expect(suggestNextSessionStartTime(["09:00", "18:00", "10:30"])).toBe("19:00");
  });

  it("caps at 23:00 so it never rolls into the next day", () => {
    expect(suggestNextSessionStartTime(["23:00"])).toBe("23:00");
  });
});

describe("formatSessionStartTime / formatSessionTimeRange", () => {
  it("formats a Postgres time string as HH:MM", () => {
    expect(formatSessionStartTime("09:05:00")).toBe("09:05");
  });

  it("formats a same-day range as start–end", () => {
    expect(formatSessionTimeRange("18:00", 90)).toBe("18:00–19:30");
  });

  it("falls back to start + duration label when the range crosses midnight", () => {
    expect(formatSessionTimeRange("23:30", 90)).toBe("23:30 (90 min)");
  });
});

describe("addDaysToISODate", () => {
  it("adds days without a UTC shift", () => {
    expect(addDaysToISODate("2026-07-20", 1)).toBe("2026-07-21");
  });

  it("rolls over month boundaries", () => {
    expect(addDaysToISODate("2026-07-31", 1)).toBe("2026-08-01");
  });

  it("supports negative offsets", () => {
    expect(addDaysToISODate("2026-07-01", -1)).toBe("2026-06-30");
  });
});
