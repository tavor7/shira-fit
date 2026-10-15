# Phase 1 · Step 4 — Session detail screens in parallel: results

| | |
|---|---|
| Branch | `perf/phase1-step4-detail-parallel` (local only; on top of Step 3). Code commit `fd7d296`. |
| Status | implemented and measured locally; **not merged, not deployed**; no database changes; no RLS or authorization changes |
| Compared against | the Phase 0 baseline **and** Step 3; same isolated stack, harness and latency model |

## What changed

| Screen | Before | After |
|---|---|---|
| **Athlete session detail** | Up to 7 sequential round trips: session → registration-open state (when not open) → signup count → own registration → own waitlist entry → participant names | **One wave:** session ∥ signup count ∥ own registration ∥ own waitlist entry ∥ participant names. The registration-open lookup follows only when the session isn't open yet (it was already conditional). |
| **Participant attendance list** (roster on the coach and manager session pages, and the missing-attendance screen) | 5 sequential reads: session → roster price overrides → registrations (+ profiles) → manual participants → … prices → receipt locks (coaches) | session ∥ roster price overrides ∥ registrations (+ profiles) ∥ manual participants ∥ receipt locks (coaches) → per-row prices (already parallel) |
| **Manager session detail** | waitlist, cancellations and notes started only after the session row and the tier price lookup | they start together with the session row |

**Kept exactly as before:**
- **The athlete page still appears only when everything is known.** The register, cancel and waitlist buttons never render before the athlete's own registration/waitlist status. Progressive rendering (header first) was considered and **not** done: with one wave, the whole page arrives in a single round trip, so it would gain almost nothing and would add a state where the actions must be disabled.
- **The same requests, with the same filters and error handling:**
  - a session error still shows "not found";
  - a participant-list error still leaves the names untouched;
  - the `date_of_birth` column fallback is kept;
  - managers still don't request receipt locks.
- **Ownership:** a newer load can't be overwritten by an older, slower one on the athlete page (sequence guard, new).
- **The coach session page itself was not edited**, so this step can't conflict with the security workstream. It benefits through the shared roster component.

**Files:**
- `app/(app)/athlete/session/[id].tsx`
- `app/(app)/manager/session/[id].tsx`
- `src/components/ParticipantAttendanceList.tsx`
- harness: `harness/compare-ui.mjs` (new `PERF_UI_SET=detail` scenarios)

## Correctness verification [M-local]

| Check | Result |
|---|---|
| **What users see**, Step 3 build vs Step 4 build ([script](harness/compare-ui.mjs), `PERF_UI_SET=detail`), Chromium **and** WebKit | **16 of 16 identical** (all visible text and accessibility labels, after data settled). The 8 scenarios were: athlete registered / not yet open / open / on the waitlist; coach's own session with roster (registrations, walk-ins, prices, receipt locks); manager session with roster; manager session with manual participants only; super user. |
| **Same requests**, coach session page, Step 3 vs Step 4 build | **Identical set: 20 requests each**, including 8 price lookups and the receipt-lock check. Only the timing differs: everything is done by ~535 ms instead of ~1,600 ms. Direct load of the page: 36 vs 36. |
| Jest | **756 passed**, 8 skipped (unchanged from Step 3) |
| `tsc --noEmit` | clean |
| Lint | every edited file has identical warnings before/after: athlete detail 0/0, manager detail 12/12, attendance list 7/7 (all pre-existing) |
| Migrations | the four local migration edits are untouched (fingerprints match) |

## Results [M-local] — median of 5 runs

Full tables: [Chromium](data/2026-10-15-phase1-step4-vs-baseline-chromium.md), [WebKit](data/2026-10-15-phase1-step4-vs-baseline-webkit.md).

| Role | Metric (Chromium / WebKit) | Baseline | Step 3 | **Step 4** | Δ vs baseline | Δ vs Step 3 |
|---|---|---|---|---|---|---|
| Athlete | **Open session: tap → content** | 1,317 / 1,470 | 1,051 / 1,178 | **244 / 365 ms** | **−81% / −75%** | −77% / −69% |
| Athlete | Open session: sequential depth before content | 6 | 5 | **1** | −5 | −4 |
| Athlete | Open session: all settled | 2,060 / 2,293 | 1,347 / 1,518 | **525 / 906 ms** | −75% / −60% | −61% / −40% |
| Coach | **Open own session: roster fully loaded** (settled) | 1,461 / 1,634 | 1,497 / 1,649 | **752 / 754 ms** | **−49% / −54%** | −50% / −54% |
| Manager | **Session roster: focus → content** | 1,264 / 1,431 | 1,259 / 1,439 | **645 / 791 ms** | **−49% / −45%** | −49% / −45% |
| Manager | Open session: tap → content (header and form) | 249 / 281 | 246 / 283 | 250 / 288 ms | unchanged | unchanged |
| All | Requests per screen | | | **unchanged** (same set; see below) | | |

Screens not touched by this step (cold start, back to home, menu, realtime, dashboard) are within noise of Step 3. See the flagged items below.

## Items flagged by the regression scan, and the outcome

- **Coach/manager "requests before content" went up** (coach 8 → 12, manager 6 → 9). **This is not an increase.**
  - The total set is unchanged (traced request by request above).
  - The same requests now start earlier, so more of them are in flight before the page's content mark.
  - For the manager, the waitlist, cancellations and notes requests now fall inside the measured window, where before they started after it.
- **The coach "all requests" count rose from 16 to 20** in the harness window. Same explanation: Step 3's slower tail (prices and the receipt-lock check, ~1.4–1.6 s) landed after the harness stopped counting. A direct trace shows 20 = 20.
- **Cold start, coach (Chromium): +227 ms vs Step 3.**
  - Step 4 doesn't change anything that runs before the home screen.
  - The "home mounts" time moved by the same amount (+111 ms), which points to the environment.
  - Run ranges: Step 3 1,114–1,374 ms; Step 4 1,197–1,503 ms.
  - Classified as drift, as in Step 3.
- **Cold start, athlete:** one run at 3,993 ms (the others 1,241–1,685). This is an outlier; the median is 1,311 ms.
- **WebKit, athlete cold start +1,036 ms and back-to-home skeleton +289 ms vs Step 3.**
  - Run ranges were very wide: cold start 1,501–4,603 ms (Step 3: 1,351–1,807).
  - Request counts were identical (29 and 15).
  - Those runs overlapped with a Chromium request trace I was running at the same time, so the machine was busy.
  - **Back-to-back re-run** of the Step 3 and Step 4 builds (WebKit, athlete, nothing else running; [step 3](data/2026-10-15-phase1-step4-drift-check-step3-build-webkit.json), [step 4](data/2026-10-15-phase1-step4-drift-check-step4-build-webkit.json)):
    - cold start: Step 3 2,055 ms, Step 4 1,526 ms;
    - back to home: Step 3 676 ms, Step 4 698 ms (+22 ms);
    - open session: Step 3 1,198 ms, Step 4 275 ms.
  - **No regression**; it was machine load.
- **Athlete home "depth before content" 2 → 3:** Step 3's own runs showed 2–3 (2,3,2,2,2). Step 4 doesn't touch the home. Run-to-run variation.
- **Dashboard → Global:** dominated by the slow server function (Phase 3). Step 4 doesn't touch it. Runs ranged 1,757–3,105 ms (Step 3: 1,734–2,781 ms). Noise.

## Real device

**[Pending device]** These are local measurements with modelled latency. Improvements on your iPhone Home Screen PWA will be confirmed from your measurements.
