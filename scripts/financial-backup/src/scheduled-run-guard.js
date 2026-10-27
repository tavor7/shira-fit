import { loadProductionManifests, loadRestoreTestResults } from "./backup-queries.js";

// Decides whether a `schedule`-triggered workflow run should actually do anything, for BOTH the
// daily-backup and weekly-restore-test schedules. Two independent questions, both answered
// without any strict wall-clock-hour check (GitHub Actions scheduled runs "may start late or
// occasionally be skipped" -- a strict hour-equality guard would incorrectly skip a delayed run,
// which is exactly the failure mode to avoid):
//
// 1. "Is this cron entry the one for Israel's CURRENT daylight-saving state?" -- a real GitHub
//    Actions cron can't express "only in summer," so there are two cron lines per schedule (one
//    assuming IDT, one assuming IST); each run checks whether Israel's ACTUAL current UTC offset
//    matches what it was written for, and no-ops if not. This is a multi-month-stable condition
//    (the offset only flips twice a year) -- a run being minutes or even hours late never
//    changes which DST state is "current," so this check is robust to exactly the delay the
//    brief warns about, unlike a tight hour-equality check.
// 2. "Has the intended work already happened recently enough?" -- daily backup: is there already
//    a production backup whose created_at falls on TODAY's Israel calendar date? Weekly restore-
//    test: has any restore-test run in roughly the last week? Calendar-date/rolling-window
//    checks, not hour checks -- a late run still finds "not done yet" and proceeds; an
//    already-done day/week correctly no-ops instead of creating a duplicate.
//
// Usage: GUARD_KIND=daily-backup|weekly-restore-test EVENT_SCHEDULE="<cron string>" node
// scheduled-run-guard.js. Writes should_run=true|false (and, for weekly-restore-test, nothing
// else -- backup_id selection is select-latest-verified-backup.js's job) to $GITHUB_OUTPUT.

const SEASON_BY_CRON = {
  "0 0 * * *": "IDT",
  "0 1 * * *": "IST",
  "0 2 * * 0": "IDT",
  "0 3 * * 0": "IST",
};

function currentIsraelUtcOffsetHours() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "longOffset" }).formatToParts(new Date());
  const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = offset.match(/GMT([+-]\d+)/);
  return m ? Number(m[1]) : null;
}

function currentIsraelDstState() {
  const h = currentIsraelUtcOffsetHours();
  if (h === 3) return "IDT";
  if (h === 2) return "IST";
  // Never guess -- an unrecognized offset means something is wrong (a tzdata change, a leap
  // second oddity, whatever) and this run should be investigated, not silently skipped OR run.
  throw new Error(`Unexpected Israel UTC offset (${h}) -- refusing to guess the DST state.`);
}

function israelDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(date); // YYYY-MM-DD
}

async function writeOutput(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function main() {
  const guardKind = process.env.GUARD_KIND;
  const eventSchedule = process.env.EVENT_SCHEDULE;
  if (!["daily-backup", "weekly-restore-test"].includes(guardKind)) {
    throw new Error(`GUARD_KIND must be "daily-backup" or "weekly-restore-test", got: "${guardKind}"`);
  }
  if (!eventSchedule) throw new Error("EVENT_SCHEDULE is required (the exact cron string that fired, from github.event.schedule).");

  const expectedSeason = SEASON_BY_CRON[eventSchedule];
  if (!expectedSeason) throw new Error(`Unrecognized cron string "${eventSchedule}" -- add it to SEASON_BY_CRON if this is a real new schedule entry.`);

  const actualSeason = currentIsraelDstState();
  if (actualSeason !== expectedSeason) {
    console.log(`Skipping -- this cron entry (${eventSchedule}) is for Israel ${expectedSeason}, but Israel is currently ${actualSeason}.`);
    await writeOutput("should_run", "false");
    return;
  }

  if (guardKind === "daily-backup") {
    const today = israelDateString();
    const manifests = await loadProductionManifests();
    const alreadyDoneToday = manifests.some((m) => israelDateString(new Date(m.created_at)) === today);
    if (alreadyDoneToday) {
      console.log(`Skipping -- a production backup already completed today (Israel date ${today}).`);
      await writeOutput("should_run", "false");
      return;
    }
    console.log(`Proceeding -- no production backup yet for today (Israel date ${today}).`);
    await writeOutput("should_run", "true");
    return;
  }

  // weekly-restore-test: has one run in roughly the last week? A rolling-hours window, not an
  // ISO-week boundary -- simpler, and avoids any edge case at the week boundary itself.
  const ROLLING_WINDOW_HOURS = 6 * 24; // ~6 days, deliberately a little under 7 so a slightly
  // early recurrence never creates a multi-day gap from one delayed run pushing the next one out.
  const results = await loadRestoreTestResults();
  const mostRecent = results[0] ?? null;
  const hoursSinceLast = mostRecent ? (Date.now() - new Date(mostRecent.tested_at).getTime()) / 36e5 : Infinity;
  if (hoursSinceLast < ROLLING_WINDOW_HOURS) {
    console.log(`Skipping -- the last restore-test ran ${Math.round(hoursSinceLast)}h ago (within the last ${ROLLING_WINDOW_HOURS}h).`);
    await writeOutput("should_run", "false");
    return;
  }
  console.log(`Proceeding -- ${Number.isFinite(hoursSinceLast) ? Math.round(hoursSinceLast) + "h" : "no prior run"} since the last restore-test.`);
  await writeOutput("should_run", "true");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
