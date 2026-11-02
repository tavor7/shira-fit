# Phase 3B — Overview / dashboard statistics: price each slot once per call

Branch `perf/weekly-stats-price-memo` (from `main` 52d3001). **Not deployed; needs your final review and approval.**
Labels: [M-prod] production read-only · [M-local] isolated perf stack (seeded, ≈ production shape) · [E] estimate.

## Root cause (confirmed)

- [M-prod] `manager_weekly_stats` as a manager: week 100 ms / 21 KB, month 70 ms / 36 KB, **global 4.78 s / 626 KB**.
- The engine called `session_billing_price_ils` at **19 sites** (14 in `manager_weekly_stats_core`, 5 in
  `_period_merged_athlete_finance`, which the families block runs again), so each slot was priced ~3-4 times. The function
  is SECURITY DEFINER with a pinned `search_path`, so Postgres cannot inline it. Not causes: indexes (date range scans are
  indexed), RLS (SECURITY DEFINER).

## Implementation — migration `20261102120000_weekly_stats_price_once_per_call.sql`

- `_mws_prepare_price_memo(start, end)` (internal, not executable by API roles): stores
  `session_billing_price_ils(session, user, manual)` for **exactly the slots the engine prices** (active registrations
  and walk-ins that attended or are charged no-shows; full-price cancellations) in a transaction-local temp table, then
  sets a transaction-local flag. In a read-only transaction it does nothing.
- `_mws_price(session, user, manual)` (internal): the stored value when the flag is on and the slot is stored, otherwise
  `session_billing_price_ils` exactly as before. A missing memo can only cost time, never change a value.
- `manager_weekly_stats_core`, `_period_merged_athlete_finance`, `manager_weekly_stats`: the **deployed definitions**
  with only these edits — the 19 calls become `_mws_price(...)` with the same arguments; the core prepares the memo right
  after computing the period; the wrapper turns the flag off after the families block. Filters, rounding, hidden-
  registration rules, manager / super-user checks, output shape and periods are untouched.
- Safety: md5 precondition on the three bodies and both price-function overloads (checked equal to production
  2026-11-02); post-check of the new bodies; no data written outside the per-call temp table; no historical record
  touched. A re-run is refused by the precondition (nothing changes).
- Compatibility: `manager_weekly_stats_core` stays directly executable by API roles (as today) and prepares its own memo;
  production's legacy one-argument `manager_weekly_stats(date)` delegates to the wrapper and is unaffected.

## Exact financial-output comparison — suite `supabase/tests/203` (final implementation)

The original engine is recreated inside the test transaction by reversing exactly the migration's edits (the clones'
bodies are asserted byte-identical to the reviewed production bodies), then compared with the memo engine:

| Check | Result |
|---|---|
| E1 every week (33 incl. an empty future one), every month (9) and global, manager and super user | byte-identical |
| E2 direct calls of `manager_weekly_stats_core` (week, month, global) | byte-identical |
| E3 athlete, no-profile and anonymous callers | same refusal JSON |
| E5 a roster price changed between two calls in one transaction | reflected; identical to the original engine |
| E6 memo flag after the wrapper | off |
| R1 read-only transaction (memo skipped) | output identical to read-write |
| **Total** | **97 / 97 outputs byte-identical**; all checks pass |

## Measured performance [M-local, suite 203 and harness]

| Mode | `session_billing_price_ils` calls | DB time, manager / super user |
|---|---|---|
| Global | 6,027 → 2,009 (−67%) | 2,329 / 1,698 ms → 529 / 452 ms |
| Month (avg of 9) | 687 → 229 | 204 / 185 ms → 80 / 71 ms |
| Week (avg of 33) | 187 → 62 | 65 / 71 ms → 29 / 32 ms |
| Current month, direct core | 18 → 9 | 18.0 → 15.7 ms |

No case calls the price function more often than before (an earlier draft that priced every slot of the period made the
current month slower; it was corrected before these measurements).

End to end (same app build, menu → Overview → Month → Global, 3 runs each) [M-local]: Global click → content
**2,378 ms → 1,111-1,401 ms**; Week / Month unchanged within noise (network-bound). Production estimate for global
[E]: ≈4.8 s → ≈1.5-2 s of DB time (production runs 2-3.5× slower than the local stack).

Resource use: one transaction-local temp table per call (≈2,000 rows in global mode, dropped at commit), two small
indexes on it; no persistent objects besides the two internal functions.

## Proposal B — evaluated, not implemented (recommendation)

Global payload by section [M-local]: `finance.coaches` 192 KB, `finance.expected_by_day` 178 KB,
`finance.collections_by_day` 176 KB (the per-day lists are read only by the Finance breakdown screen). With the memo in
place the two per-day blocks cost **~50 ms of ~600 ms** server time in global mode; in week / month mode they are 1-3 KB.
Skipping them would need a new signature for two directly-callable financial functions (drop / recreate / re-grant),
section-skipping branches inside the engine and changes in three screens, for a gain limited to the rarely used global
view (≈45 KB gzip, ≈50 ms). Per your criterion this is marginal; **keep Proposal A alone**. Revisit if global becomes a
frequent view or history grows several-fold.

## Rollback

`docs/performance/rollback/20261102120000_weekly_stats_price_once_per_call_ROLLBACK.sql`: precondition = the migrated
bodies; restores the three original definitions byte-for-byte; drops both helpers; post-check = the original
fingerprints. Exercised on the perf stack (rollback → re-apply).

## Release readiness

- Ready for your final review. Deploy = `supabase db push --linked` (migration only; no app change). Post-deploy:
  read-only production comparison of current-week / month / global output against the original engine reconstructed in a
  rolled-back transaction is not possible on production (it needs DDL), so the production check is: the post-check
  fingerprints, timings per mode as a manager (read-write call through the API), and Postgres error logs.
- Residual risk: low; the comparison covers every period of a production-shaped dataset for both privileged roles.
