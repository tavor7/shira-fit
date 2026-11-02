// Navigation behaviour suite (Performance Phase 3) for the ISOLATED perf stack: runs the same scripted journeys in
// Chromium and WebKit and prints what the user would see (URL, screens mounted, prompts). Read-only except that it
// types into a Create Session form it never saves.
//   N1 repeated menu navigation: mounted screens after each of 12 taps (manager)
//   N2 Back / Forward after returning to an open section
//   N3 unsaved Create Session form + menu: prompt, Cancel keeps the edit, Discard leaves
//   N4 deep link (cold open of a subscription) + menu Sessions + Back
//   N5 coach: repeated menu navigation
//   N6 menu opened then browser Back: the menu closes, the page stays
//   N7 in-app header back arrow after a menu push
//   N8 reload on a section restores it
// ONLY=N7 runs a single journey.
// Usage: PLAYWRIGHT_MODULE_DIR=… BASE=http://127.0.0.1:<port> ENGINE=chromium|webkit SUB_ID=<subscription id> node nav-suite.mjs
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pw = require(path.join(process.env.PLAYWRIGHT_MODULE_DIR ?? "", "playwright"));
const BASE = process.env.BASE;
const ENGINE = process.env.ENGINE ?? "chromium";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(BASE ?? "")) throw new Error("local targets only");

const browser = await pw[ENGINE].launch({ headless: true });
const out = { engine: ENGINE, base: BASE };

async function session(email, startPath) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("shira_fit_language", "en"));
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(3000);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("PerfPass123!");
  await page.getByText("Sign in", { exact: true }).click();
  await page.waitForTimeout(6000);
  if (startPath) {
    await page.goto(`${BASE}${startPath}`);
    await page.waitForTimeout(5000);
  }
  return { ctx, page };
}
const here = (page) => page.url().replace(BASE, "");
const screens = (page) => page.locator('[aria-label="Open navigation menu"]').count();
async function menu(page, name) {
  await page.locator('[aria-label="Open navigation menu"]').locator("visible=true").first().click();
  await page.getByRole("button", { name, exact: true }).locator("visible=true").first().click();
  await page.waitForTimeout(2500);
}
const browserBack = async (page) => { await page.goBack().catch(() => {}); await page.waitForTimeout(2000); return here(page); };
const browserFwd = async (page) => { await page.goForward().catch(() => {}); await page.waitForTimeout(2000); return here(page); };

async function step(name, fn) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = { error: String(e?.message ?? e).split("\n")[0] };
  }
}

await step("N1_N2_manager_menu", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test");
  const seq = ["Overview", "Money", "Roster calendar", "Sessions"];
  const depth = [];
  for (let i = 0; i < 12; i++) {
    await menu(page, seq[i % 4]);
    depth.push(await screens(page));
  }
  const at = here(page);
  const back1 = await browserBack(page);
  const fwd1 = await browserFwd(page);
  await ctx.close();
  return { mountedAfterEachTap: depth, at, back1, fwd1 };
});

await step("N3_unsaved_form", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test");
  await page.getByText(/^mon$/i).locator("visible=true").first().click();
  await page.waitForTimeout(1500);
  await page.getByText("Add session", { exact: true }).locator("visible=true").first().click();
  await page.waitForTimeout(3000);
  const input = page.locator("input[type=text], input:not([type]), textarea").locator("visible=true").first();
  await input.fill("123");
  const typed = await input.inputValue();
  await menu(page, "Sessions");
  const r = { onForm: here(page), prompt: (await page.getByText("Leave without saving?").count()) > 0 };
  if (r.prompt) {
    await page.getByText("Cancel", { exact: true }).locator("visible=true").last().click();
    await page.waitForTimeout(1000);
    r.afterCancel = here(page);
    r.editKept = (await page.locator("input[type=text], input:not([type]), textarea").locator("visible=true").first().inputValue()) === typed;
    await menu(page, "Sessions");
    await page.getByText("Discard", { exact: true }).locator("visible=true").last().click();
    await page.waitForTimeout(2000);
    r.afterDiscard = here(page);
    r.screensAfterDiscard = await screens(page);
  } else {
    r.afterMenu = here(page);
    r.back = await browserBack(page);
  }
  await ctx.close();
  return r;
});

await step("N4_deep_link", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test", `/manager/subscriptions/${process.env.SUB_ID}`);
  const opened = here(page);
  await menu(page, "Sessions");
  const afterMenu = here(page);
  const screensNow = await screens(page);
  const back = await browserBack(page);
  await ctx.close();
  return { opened, afterMenu, screensNow, back };
});

await step("N5_coach_menu", async () => {
  const { ctx, page } = await session("perf-coach-1@perf.test");
  const depth = [];
  for (let i = 0; i < 6; i++) {
    await menu(page, i % 2 === 0 ? "Athlete activity" : "Sessions");
    depth.push(await screens(page));
  }
  await ctx.close();
  return { mountedAfterEachTap: depth };
});

await step("N6_menu_then_browser_back", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test");
  await menu(page, "Overview");
  const before = here(page);
  await page.locator('[aria-label="Open navigation menu"]').locator("visible=true").first().click();
  await page.waitForTimeout(800);
  const menuOpen = (await page.getByRole("button", { name: "Money", exact: true }).locator("visible=true").count()) > 0;
  const after = await browserBack(page);
  const menuClosed = (await page.getByRole("button", { name: "Money", exact: true }).locator("visible=true").count()) === 0;
  const back2 = await browserBack(page);
  await ctx.close();
  return { before, menuOpen, afterBack: after, menuClosed, secondBack: back2 };
});

await step("N7_header_back_arrow", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test");
  await menu(page, "Overview");
  const before = here(page);
  await page.locator('[aria-label^="Back to"], [aria-label="Go back to previous screen"]').locator("visible=true").first().click();
  await page.waitForTimeout(2000);
  const after = here(page);
  const screensNow = await screens(page);
  await ctx.close();
  return { before, after, screensNow };
});

await step("N8_reload_restores", async () => {
  const { ctx, page } = await session("perf-mgr-2@perf.test");
  await menu(page, "Money");
  const before = here(page);
  await page.reload();
  await page.waitForTimeout(6000);
  const after = here(page);
  await ctx.close();
  return { before, after };
});

await browser.close();
console.log(JSON.stringify(out, null, 1));
