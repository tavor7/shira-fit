// Summarizes run-screens.mjs output: per role and step, the median of tap→content, settled time, request count and KB,
// one column group per label (e.g. before / after). Usage: node summarize-screens.mjs <a.json> [b.json ...]
import fs from "node:fs";

const med = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const byLabel = new Map();
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const list = byLabel.get(r.label) ?? [];
  list.push(...r.results.filter((x) => !x.error));
  byLabel.set(r.label, list);
  const failed = r.results.filter((x) => x.error);
  for (const x of failed) console.log(`- ${r.label} ${x.role} run ${x.run + 1} FAILED: ${x.error}`);
}
const labels = [...byLabel.keys()];
const head = labels.map((l) => `${l}: tap→content / settled / req / KB`).join(" | ");
console.log(`| Role | Step | ${head} |`);
console.log(`|---|---|${labels.map(() => "---").join("|")}|`);
const order = [];
for (const res of byLabel.values()) for (const x of res) for (const s of Object.keys(x.steps)) if (!order.some(([r, k]) => r === x.role && k === s)) order.push([x.role, s]);
for (const [role, step] of order) {
  const cells = labels.map((l) => {
    const xs = byLabel.get(l).filter((x) => x.role === role && x.steps[step]).map((x) => x.steps[step]);
    if (!xs.length) return "–";
    const n = xs.length;
    return `${med(xs.map((s) => s.navToContentMs))} ms / ${med(xs.map((s) => s.settledMs))} ms / ${med(xs.map((s) => s.requests))} / ${med(xs.map((s) => s.kb))} (n=${n})`;
  });
  console.log(`| ${role} | ${step} | ${cells.join(" | ")} |`);
}
