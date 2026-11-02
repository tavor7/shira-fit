# Performance Phase 3 — remaining bottlenecks (2026-11-02)

Branch `perf/phase3` from `origin/main` 8fa0fbf (Phase 2 deployed). Reference point: Phase 2 build C (= deployed code).
Labels: **[M-prod]** production read-only · **[M-local]** isolated perf stack (+190 ms modelled latency; this phase measured
with the unrelated local Docker stacks paused, so timings are steadier than Phase 2's) · **[E]** estimate.

## Phase 2 release verification (deployed 2026-11-02)

- Migrations 20261101090000 + 20261101091000 applied 08:32:12-19Z (`supabase db push --linked`, history in sync before).
  Pre-check: production `sessions_select` md5 = reviewed baseline; price function byte-identical to the tested one.
- Post-checks [M-prod, read-only]: batch vs per-row prices **3,500 roster rows, 0 mismatches**; `training_sessions`
  visibility identical under original vs migrated policy for an approved athlete (274 rows), a coach and a manager (891),
  a pending / disabled athlete (0); other policies unchanged; athlete calendar query **82.3 → 7.4 ms**.
- PR #11 merged (8fa0fbf) 08:34Z; Render served the new bundle 08:36:28Z. Hashed assets now
  `max-age=31536000, immutable`; `index.html`, `sw.js`, `manifest.json` still `max-age=0` (new releases picked up on the
  next launch; service-worker updates unaffected). No 4xx/5xx or Postgres errors after the release.

## Priority 1 — `manager_weekly_stats` (proposal; needs your review before implementation)

**Confirmed root causes**
1. **Global mode recomputes all history and ships it:** production week 100 ms / 21 KB, month 70 ms / 36 KB, **global
   4.78 s / 626 KB** [M-prod, read-only as a manager]. The 584 ms production mean is mostly a few global calls.
2. **The same slot prices are computed ~4 times per call:** `session_billing_price_ils` is called at 19 sites across the
   core (arrived money, per-athlete expected, expected-by-day) and `_period_merged_athlete_finance` (used again by the
   families block). It is SECURITY DEFINER with a pinned `search_path`, so Postgres cannot inline it; pricing was ~70% of
   execution time in the local profile.
3. **Three screens run the full computation for one part of it:** Missing Attendance uses only `missing_attendance`;
   Finance breakdown only the per-day lists; the dashboard does not use the per-day session lists.
4. Not causes: index usage (session-date range scans are indexed) and RLS (SECURITY DEFINER bypasses it).

**Proposal A — compute each slot price once per call (no API change).** A per-call memo of
`session_billing_price_ils(session, user, manual)` for every slot of the period; every call site reads it (and computes
on a miss, so it can never return a value the current engine would not). Prototype:
[phase3/manager_weekly_stats_price_memo_prototype.sql](phase3/manager_weekly_stats_price_memo_prototype.sql) (one
rolled-back transaction).

| Mode [M-local] | Current | Prices once | Change |
|---|---|---|---|
| Global (manager / super user) | 1,335 / 1,470 ms | 590 / 589 ms | −56% / −60% |
| Month (avg of 9) | 199 / 164 ms | 93 / 80 ms | −53% / −51% |
| Week (avg of 32) | 55 / 44 ms | 32 / 26 ms | −41% |

Equivalence: full JSON output **byte-identical** for all 32 weeks, 9 months and global, as a manager and as a super
user (84/84). Production estimate for global: ≈4.8 s → ≈2 s [E]. Implementation = a migration replacing three
financial functions (same outputs); review items: the memo is a temp table per call; the equivalence suite becomes a
regression test.

**Proposal B — stop shipping what a screen does not use (API change, larger gain for global).** Add an optional
`p_sections` argument (default = everything, so old app versions are unaffected); the dashboard skips the per-day session
lists, Missing Attendance asks only for `missing_attendance`, Finance breakdown only for the per-day lists. Global payload
626 KB → [to measure after A]; needs your decision on the API shape.

## Priority 2 — navigation stack (prototype; needs your UX decision)

**Root cause:** staff menu items use `router.push`, so every tap adds another copy of a section. 12 menu taps → **13
mounted screens**, 87-91 MB JS heap, ~15,000 DOM nodes [M-local, Chromium]; Back retraces every tap. (Athlete sections
are tabs and never stack.)

**Prototype (commit 53807ea):** a staff destination already in the stack is returned to (`router.dismissTo`); others are
pushed as before.

| 12 menu taps [M-local] | Current | Prototype |
|---|---|---|
| Mounted screens | 2 → 13 | cycles 1-4 |
| JS heap / DOM nodes (Chromium) | 87-91 MB / ~15,000 | 26 MB / 1,131 |
| Menu → Sessions, tap → content | 910 ms | **458 ms** |
| Requests per realtime event | 20 | 17 |

UX differences (demonstrated with scripted flows, Chromium and WebKit):
- Back after jumping to an open section no longer retraces earlier menu taps (Sessions behaves like Home).
- Unsaved Create Session form + menu → Sessions: today the form silently stays underneath (Back returns to it, edit kept);
  with the prototype the existing **"Leave without saving?"** prompt appears (Cancel keeps the edit; Discard goes home).
- **Open issue, why it is not ready:** after returning to Sessions, the *browser* Back button behaves differently by
  engine: Chromium stays on Sessions, WebKit (iPhone Safari) walks the browser history (Money → Overview → Sessions).
  Web history needs to be aligned with the stack before this can ship. Deep links and role routing are untouched (the
  helper only acts when the destination is already open). Native iOS / Android not tested.

Options for you: (1) keep push (today; Phase 2 already made hidden copies cheap); (2) the prototype after fixing the
web-history issue; (3) only "Sessions" returns to home, every other item pushes.

## Priority 3 — redundant background work (implemented)

| Item | Root cause | Change (freshness rule) | Measured [M-local] |
|---|---|---|---|
| Subscription-terms gate | re-read on every navigation + every 60 s + resume | navigation re-checks only if the last check is ≥ 30 s old; login, resume and the 60 s timer unchanged → never more than 60 s behind the server (same bound); server still enforces | −1 request on almost every navigation |
| Athlete push re-sync | both syncs (2 Auth `getUser` calls) on every athlete-home focus | at most every 10 min; login / preference / permission / activation sync immediately; login counts as the latest | athlete return to home 15 → 12 requests |
| Duplicate realtime listeners | hidden home copies (banner channel per copy) | addressed by Priority 2 if approved; banner behaviour itself unchanged | — |
| Resume (6 requests) | all distinct gate reads, already de-duplicated in Phase 2 | none | — |

## Before / after (Phase 2 build C → Phase 3 build P, 4 runs each, Chromium) [M-local]

| Workflow | C | P | Change |
|---|---|---|---|
| Manager menu → Sessions (tap → content) | 910 ms, 21 req | 458 ms, 17 req | −50% (navigation prototype) |
| Manager other menu destinations / tabs / back | 4-18 req | 1 fewer each | terms throttle; time within noise |
| Athlete back to home / menu → Sessions | 15 req | 12 req | −3 (push + terms) |
| Athlete My Sessions | 3 req | 2 req | −1 |
| Coach Athlete activity | 420 ms (393-524), 1 req | 516 ms (486-537), 0 req | ranges overlap; no network on this step — not a measured change |
| `manager_weekly_stats` (prototype only) | see Priority 1 | | not in build P |

## Functional regression evidence

- compare-ui C vs P: home (12 scenarios: 3 athletes this/next week + My Sessions, coach, manager, super user) and Session
  Detail (8 scenarios) — **20/20 identical in Chromium and 20/20 in WebKit**.
- Jest 837 passed (+9: menu navigation 6, push schedule 3), 8 skipped (pre-existing). tsc clean. Lint 0 errors.
- Weekly-stats prototype: 84/84 byte-identical outputs (rolled back; nothing deployed or committed as a migration).
- Not covered: real iPhone / Android devices, Hebrew UI in compare-ui.

## Database and security implications

- Committed Phase 3 changes are **client-only**: no migrations, no RLS or permission changes.
- Proposal A would replace three SECURITY DEFINER financial functions with output-identical versions (separate review).
- Proposal B would add an optional RPC argument (backward compatible).

## Release readiness

- Ready for review, not for merge: commits 56bf5fe (terms throttle) and 5e26dad (push re-sync) are low risk and
  independently releasable.
- 53807ea (navigation prototype) must **not** ship until the web-history issue is fixed and you choose an option.
- Priority 1 needs your go-ahead to implement Proposal A (and a decision on B).
