// Summarizes run-scenarios.mjs output into median / p90 tables (markdown on stdout).
// Usage: node summarize-results.mjs <results.json> [more.json ...]
import fs from "node:fs";

const files = process.argv.slice(2);
const pct = (xs, p) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1);
  return v[Math.max(0, i)];
};
const fmt = (xs, unit = "") => {
  const m = pct(xs, 50);
  const p = pct(xs, 90);
  if (m == null) return "–";
  return m === p ? `${m}${unit}` : `${m}${unit} (p90 ${p}${unit})`;
};

for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  const ok = data.results.filter((r) => !r.error);
  const failed = data.results.filter((r) => r.error);
  console.log(`\n### ${data.engine}: ${ok.length} successful runs${failed.length ? `, ${failed.length} failed` : ""}\n`);
  for (const r of failed) console.log(`- FAILED ${r.role} run ${r.run + 1}: ${r.error}`);

  const rows = [];
  const add = (label, get, unit = " ms") => {
    for (const role of ["athlete", "coach", "manager"]) {
      const vals = ok.filter((r) => r.role === role).map(get).filter((x) => x !== undefined);
      if (vals.some((v) => v != null)) rows.push([role, label, fmt(vals, unit)]);
    }
  };
  add("Cold start: content since navigation start", (r) => r.steps.coldStart?.home?.contentAtSinceNavStart);
  add("Cold start: startup (shell) requests", (r) => r.steps.coldStart?.startup?.requests, "");
  add("Cold start: startup sequential depth", (r) => r.steps.coldStart?.startup?.depth, "");
  add("Cold start: home requests before content", (r) => r.steps.coldStart?.home?.requestsBeforeContent, "");
  add("Cold start: home depth before content", (r) => r.steps.coldStart?.home?.depthBeforeContent, "");
  add("Cold start: all requests settled (since nav start)", (r) => {
    const s = r.steps.coldStart;
    if (!s?.home) return null;
    const home = s.home.settledMs != null ? s.home.settledMs + (s.home.contentAtSinceNavStart - s.home.focusToContentMs) : null;
    return Math.max(s.startup?.settledMs ?? 0, home ?? 0) || null;
  });
  add("Cold start: requests (network, all)", (r) => r.steps.coldStart?.network?.count, "");
  add("Cold start: response bytes (KB, gzip)", (r) => (r.steps.coldStart?.network ? Math.round(r.steps.coldStart.network.bytes / 1024) : null), " KB");
  add("Open session detail: tap→content", (r) => r.steps.openDetail?.detail?.tapToContentMs);
  add("Open session detail: requests before content", (r) => r.steps.openDetail?.detail?.requestsBeforeContent, "");
  add("Open session detail: depth before content", (r) => r.steps.openDetail?.detail?.depthBeforeContent, "");
  add("Open session detail: requests in 5 s", (r) => r.steps.openDetail?.detail?.requestsInWindow, "");
  add("Open session detail: settled", (r) => r.steps.openDetail?.detail?.settledMs);
  add("Open session detail: response KB", (r) => (r.steps.openDetail?.network ? Math.round(r.steps.openDetail.network.bytes / 1024) : null), " KB");
  add("Roster: focus→content", (r) => r.steps.openDetail?.roster?.focusToContentMs);
  add("Back to home: focus→content", (r) => r.steps.backToHome?.home?.focusToContentMs);
  add("Back to home: content hidden by loading state", (r) => r.steps.backToHome?.home?.notReadyMs);
  add("Back to home: requests in 5 s", (r) => r.steps.backToHome?.home?.requestsInWindow, "");
  add("Back to home: depth", (r) => r.steps.backToHome?.home?.depthInWindow, "");
  add("Back to home: response KB", (r) => (r.steps.backToHome?.network ? Math.round(r.steps.backToHome.network.bytes / 1024) : null), " KB");
  add("Menu → Overview (dashboard week): tap→content", (r) => r.steps.dashboardWeek?.dashboard?.tapToContentMs);
  add("Dashboard week: requests in 5 s", (r) => r.steps.dashboardWeek?.dashboard?.requestsInWindow, "");
  add("Dashboard → Month: click→content", (r) => r.steps.dashboardMonth?.clickToContentMs);
  add("Dashboard → Global: click→content", (r) => r.steps.dashboardGlobal?.clickToContentMs);
  add("Dashboard → Global: response KB", (r) => (r.steps.dashboardGlobal?.network ? Math.round(r.steps.dashboardGlobal.network.bytes / 1024) : null), " KB");
  add("Menu → Sessions (home): tap→content", (r) => r.steps.menuToHome?.home?.tapToContentMs);
  add("Menu → Sessions (home): content hidden", (r) => r.steps.menuToHome?.home?.notReadyMs);
  add("Menu → Sessions (home): requests in 5 s", (r) => r.steps.menuToHome?.home?.requestsInWindow, "");
  add("Realtime registration: requests in 5 s", (r) => r.steps.realtimeRegistration?.requestsIn5s, "");
  add("Realtime registration: skeleton flashes", (r) => r.steps.realtimeRegistration?.skeletonFlashes, "");
  add("Realtime registration: skeleton time", (r) => r.steps.realtimeRegistration?.skeletonMs);
  add("Resume after 35 s hidden: requests in 5 s", (r) => r.steps.resume?.requestsIn5s, "");

  console.log("| Role | Metric | Median (p90) |\n|---|---|---|");
  for (const [role, label, v] of rows) console.log(`| ${role} | ${label} | ${v} |`);

  const ep = {};
  for (const r of ok) {
    for (const [k, n] of Object.entries(r.steps.coldStart?.startup?.endpoints ?? {})) {
      ep[`${r.role}|${k}`] = (ep[`${r.role}|${k}`] ?? 0) + n;
    }
  }
  console.log("\nStartup (shell) requests per cold start, by endpoint (average over runs):\n");
  console.log("| Role | Endpoint | Per cold start |\n|---|---|---|");
  for (const [k, n] of Object.entries(ep).sort()) {
    const [role, e] = k.split("|");
    const runs = ok.filter((r) => r.role === role).length;
    console.log(`| ${role} | ${e} | ${(n / runs).toFixed(1)} |`);
  }
  const resume = ok.find((r) => r.steps.resume);
  for (const r of ok.filter((x) => x.steps.resume)) {
    console.log(`\nResume (${r.role}): ${JSON.stringify(r.steps.resume.endpoints)}`);
  }
  void resume;
}
