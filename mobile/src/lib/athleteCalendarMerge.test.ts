import * as fs from "fs";
import * as path from "path";
import { mergeAthleteCalendarSessions, sessionIdsOnCalendar } from "./athleteCalendarMerge";

const s = (id: string, session_date: string, start_time: string) => ({ id, session_date, start_time });

describe("mergeAthleteCalendarSessions (Performance Phase 1 / step 3)", () => {
  it("adds the hidden sessions the athlete is registered in and orders by date, then start time", () => {
    const visible = [s("v2", "2026-10-15", "18:00:00"), s("v1", "2026-10-14", "07:00:00")];
    const hidden = [{ training_sessions: s("h1", "2026-10-15", "07:00:00") }, { training_sessions: [s("h2", "2026-10-13", "20:00:00")] }];
    expect(mergeAthleteCalendarSessions(visible, hidden).map((x) => x.id)).toEqual(["h2", "v1", "h1", "v2"]);
  });

  it("never duplicates a session that comes back from both requests", () => {
    const visible = [s("a", "2026-10-15", "07:00:00")];
    const hidden = [{ training_sessions: s("a", "2026-10-15", "07:00:00") }];
    expect(mergeAthleteCalendarSessions(visible, hidden)).toHaveLength(1);
  });

  it("tolerates missing data", () => {
    expect(mergeAthleteCalendarSessions(null, undefined)).toEqual([]);
    expect(mergeAthleteCalendarSessions([s("a", "2026-10-15", "07:00:00")], [{ training_sessions: null }])).toHaveLength(1);
  });
});

describe("sessionIdsOnCalendar", () => {
  it("keeps only the athlete's rows for sessions on the calendar being shown", () => {
    const calendar = [s("a", "2026-10-15", "07:00:00"), s("b", "2026-10-16", "07:00:00")];
    expect(sessionIdsOnCalendar([{ session_id: "b" }, { session_id: "old" }, { session_id: "a" }], calendar)).toEqual(["b", "a"]);
    expect(sessionIdsOnCalendar(null, calendar)).toEqual([]);
  });
});

describe("athlete calendar requests carry no growing id lists in the URL", () => {
  const MOBILE = path.join(__dirname, "..", "..");
  const FILES = ["src/lib/trainingSessionQueries.ts", "app/(app)/athlete/sessions.tsx", "app/(app)/athlete/my-sessions.tsx"];
  it.each(FILES)("%s", (f) => {
    const code = fs.readFileSync(path.join(MOBILE, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/id\.in\.\(|\.in\(\s*["'](id|session_id)["']/);
  });
});
