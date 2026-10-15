// Compares a run-scenarios.mjs result file against the Phase 0 baseline file (same engine): medians, deltas and
// per-scenario counts of selected endpoints.
// Usage: node compare-to-baseline.mjs <baseline.json> <candidate.json> [--previous <previous-step.json>] [endpoint ...]
import fs from "node:fs";

const args = process.argv.slice(2);
const prevIdx = args.indexOf("--previous");
const prevFile = prevIdx >= 0 ? args[prevIdx + 1] : null;
if (prevIdx >= 0) args.splice(prevIdx, 2);
const [baseFile, candFile, ...endpointsArg] = args;
const endpoints = endpointsArg.length ? endpointsArg : ["auth:user"];
const base = JSON.parse(fs.readFileSync(baseFile, "utf8"));
const cand = JSON.parse(fs.readFileSync(candFile, "utf8"));
const prev = prevFile ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : null;

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const ok = (d, role) => d.results.filter((r) => !r.error && r.role === role);

const metrics = [
  ["Cold start: content since navigation start (ms)", (r) => r.steps.coldStart?.home?.contentAtSinceNavStart],
  ["Cold start: home mounts at (ms)", (r) => {
    const v = r.rawSnapshot?.visits?.find((x) => x.screen.endsWith(".home"));
    return v ? Math.round(v.focusAt) : null;
  }],
  ["Cold start: shell requests", (r) => r.steps.coldStart?.startup?.requests],
  ["Cold start: shell depth", (r) => r.steps.coldStart?.startup?.depth],
  ["Cold start: home requests before content", (r) => r.steps.coldStart?.home?.requestsBeforeContent],
  ["Cold start: home depth before content", (r) => r.steps.coldStart?.home?.depthBeforeContent],
  ["Cold start: all requests (network)", (r) => r.steps.coldStart?.network?.count],
  ["Open detail: tap→content (ms)", (r) => r.steps.openDetail?.detail?.tapToContentMs],
  ["Open detail: requests before content", (r) => r.steps.openDetail?.detail?.requestsBeforeContent],
  ["Open detail: depth before content", (r) => r.steps.openDetail?.detail?.depthBeforeContent],
  ["Open detail: settled (ms)", (r) => r.steps.openDetail?.detail?.settledMs],
  ["Roster: focus→content (ms)", (r) => r.steps.openDetail?.roster?.focusToContentMs],
  ["Back: content hidden (ms)", (r) => r.steps.backToHome?.home?.notReadyMs],
  ["Back: requests in 5 s", (r) => r.steps.backToHome?.home?.requestsInWindow],
  ["Back: depth", (r) => r.steps.backToHome?.home?.depthInWindow],
  ["Menu → Sessions: tap→content (ms)", (r) => r.steps.menuToHome?.home?.tapToContentMs],
  ["Dashboard → Global: click→content (ms)", (r) => r.steps.dashboardGlobal?.clickToContentMs],
  ["Realtime: requests in 5 s", (r) => r.steps.realtimeRegistration?.requestsIn5s],
  ["Realtime: skeleton (ms)", (r) => r.steps.realtimeRegistration?.skeletonMs],
  ["Resume: requests in 5 s", (r) => r.steps.resume?.requestsIn5s],
];

/** Requests to `endpoint` attributed to a scenario: shell+home on cold start, detail visit, back visit. */
const endpointCount = (r, step, ep) => {
  const sn = r.rawSnapshot;
  if (!sn) return null;
  const summaries = sn.summaries ?? [];
  if (step === "coldStart") {
    const homeId = r.steps.coldStart?.home?.visitId;
    const home = summaries.find((s) => s.visitId === homeId)?.endpoints?.[ep] ?? 0;
    return (r.steps.coldStart?.startup?.endpoints?.[ep] ?? 0) + home;
  }
  const id = step === "openDetail" ? r.steps.openDetail?.detail?.visitId : r.steps.backToHome?.home?.visitId;
  return summaries.find((s) => s.visitId === id)?.endpoints?.[ep] ?? 0;
};
for (const ep of endpoints) {
  for (const step of ["coldStart", "openDetail", "backToHome"]) {
    metrics.push([`${ep} requests: ${step}`, (r) => endpointCount(r, step, ep)]);
  }
}

console.log(`### ${cand.engine}: baseline → candidate (median of ${base.runs} vs ${cand.runs} runs)\n`);
const failures = cand.results.filter((r) => r.error);
for (const f of failures) console.log(`- FAILED ${f.role} run ${f.run + 1}: ${f.error}`);
const delta = (from, to) => {
  if (from == null || to == null) return "–";
  const d = to - from;
  const pct = from ? ` (${d > 0 ? "+" : ""}${Math.round((d / from) * 100)}%)` : "";
  return `${d > 0 ? "+" : ""}${Math.round(d)}${pct}`;
};
console.log(
  prev
    ? "| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |\n|---|---|---|---|---|---|---|"
    : "| Role | Metric | Baseline | Candidate | Δ |\n|---|---|---|---|---|"
);
for (const role of ["athlete", "coach", "manager"]) {
  for (const [label, get] of metrics) {
    const b = median(ok(base, role).map(get));
    const c = median(ok(cand, role).map(get));
    const p = prev ? median(ok(prev, role).map(get)) : null;
    if (b == null && c == null) continue;
    if (prev) console.log(`| ${role} | ${label} | ${b ?? "–"} | ${p ?? "–"} | ${c ?? "–"} | ${delta(b, c)} | ${delta(p, c)} |`);
    else console.log(`| ${role} | ${label} | ${b ?? "–"} | ${c ?? "–"} | ${delta(b, c)} |`);
  }
}
