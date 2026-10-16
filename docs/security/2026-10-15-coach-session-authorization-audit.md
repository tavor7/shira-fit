# Coach session permissions — authorization audit and fix plan (2026-10-15)

**Policy (your final decision, supersedes all earlier coach-editing proposals):** all session creation, deletion and configuration are **manager-only**. Coaches may only:
- add athletes to the sessions they're authorized to manage;
- remove athletes from those sessions;
- record and update attendance;
- record the payment method for a participation, within the existing financial rules.

**Method:** read-only review of production (`pg_proc` definitions and EXECUTE grants, `pg_policies`, foreign keys, triggers, aggregate activity-log counts) and of the client code. **Nothing was changed.**

---

## 1. Permission matrix — target policy vs. today

✅ allowed · ❌ denied · ⚠️ **violation today**

| Operation | Athlete | Coach, own session | Coach, other's session | Manager | Super user | **Today (coach)** |
|---|---|---|---|---|---|---|
| Create session / series | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ **allowed**: recurring via `staff_create_session_series` (any `p_coach_id`). One-off direct INSERT is already blocked by RLS. **9 coach-created sessions in production.** |
| Delete session ("this" / "this and future") | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ **allowed for ANY session**: `staff_delete_session_series_scope` has no ownership check |
| Edit date/time, duration, capacity, open/close, hide, kickbox (incl. recurring "this and future") | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ own sessions via `staff_update_session_series_scope`. Direct UPDATE is RLS-blocked, silently. |
| Session price (custom slot price) | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ own sessions via `staff_set_session_custom_slot_price` |
| Per-athlete price in a session (roster slot price) | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ own sessions via `staff_set_session_roster_slot_price` **and** direct table writes (RLS `session_roster_slot_prices_manager_or_session_coach_write`) |
| Recurring series rows (`session_series`) | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ **any coach, any series**, by direct INSERT/UPDATE/DELETE (RLS `session_series_staff_write` = coach or manager, ALL) |
| Capacity change while moving a participant | ❌ | ❌ | ❌ | ✅ | as manager | ⚠️ `staff_move_session_participant` honours `p_increase_dest_max` / `p_decrease_source_max` for coaches, with **no ownership check** on either session |
| Generate future series occurrences (creates sessions) | ❌ | ❌ | ❌ | ✅ + cron | — | ⚠️ coach-callable `maintain_session_series_horizon` (system operation) |
| Duplicate-slot cleanup (updates/deletes sessions) | ❌ | ❌ | ❌ | ✅ + system | — | ⚠️ coach-callable `reconcile_series_duplicate_sessions` |
| Reassign coach / coach pay rate | ❌ | ❌ | ❌ | ✅ | as manager | ✅ manager-only already |
| Global, per-athlete and coach pricing tables | ❌ | ❌ | ❌ | ✅ | as manager | ✅ manager-only RLS |
| Studio calendar notes, duplicate/clear day, open week, revert | ❌ | ❌ | ❌ | ✅ | as manager | ✅ manager-only |
| **Add athlete** to a session | (own registration only) | ✅ | ❌ | ✅ | as manager | ⚠️ `coach_add_athlete` has **no ownership check** (any session). Walk-in add *is* ownership-checked. |
| **Remove athlete / walk-in** | (own cancellation only) | ✅ | ❌ | ✅ | as manager | ✅ ownership-checked |
| **Attendance** | ❌ | ✅ | ❌ | ✅ | as manager | ✅ ownership-checked |
| **Payment method** with attendance | ❌ | ✅ | ❌ | ✅ | as manager | ✅ ownership-checked. Note: **amount paid** is also writable (Q1). Receipted payments are locked for non-managers by the existing guard trigger. |
| Session notes | ❌ | (existing: add/edit/delete own notes) | ❌ | ✅ | as manager | unchanged; see Q3 |
| Open next week's registration when due (`open_next_week_sessions_if_due`) | system | system | system | system | — | callable by any signed-in user; **schedule-driven, deterministic, idempotent**. It applies only the manager's configured opening, so it isn't a configuration change. Kept: it's the late-cron backup that opens registration on time. |

**Also verified safe:**
- Direct `training_sessions` INSERT/UPDATE/DELETE are manager-only (RLS).
- Internal helper functions are not executable by clients.
- `staff_set_session_custom_coach_rate` is manager-only.

**Outside this policy (noted, not changed):** coaches can call `staff_set_account_disabled`, `staff_update_profile`, `staff_update_manual_participant`, `upsert_manual_participant`. These are account and participant data, not session configuration.

**Defense-in-depth note:** every function above is also EXECUTE-able by `anon`. Their internal `auth.uid()` checks reject anonymous callers, so this isn't exploitable today. Revoking `anon` is a recommended hardening.

## 2. Confirmed vulnerabilities (server-side; bypass the UI with direct Supabase requests)

| # | Severity | Path | Impact |
|---|---|---|---|
| **V1** | **Critical** | `staff_delete_session_series_scope`: coach or manager, **no ownership check** | Any coach can delete **any** session, including other coaches' sessions and entire future series. The delete cascades to registrations (attendance, unreceipted payments), walk-ins, cancellations, registration history and waitlist. Only payments with an issued receipt are protected (receipt guard). **Production:** all 38 deletions so far were by managers. |
| **V2** | **High** | RLS `session_series_staff_write` (ALL for coach or manager) | Any coach can insert, update or delete **any** recurring-series row directly: schedule, coach, status. Deleting a series cascades to its occurrence ledger and detaches its sessions (`series_id` → NULL). Updating it changes what future generation creates. |
| **V3** | **High** | `staff_create_session_series`: coach allowed, `p_coach_id` unchecked | Coaches can create sessions and series, including for other coaches. **Used in production: 9 coach-created sessions.** |
| **V4** | **High** | `staff_update_session_series_scope`: coach allowed on own sessions | Coaches can change time, capacity, open/hidden, kickbox and price, for one session or "this and future". |
| **V5** | **High** | `staff_move_session_participant`: coach allowed, **no ownership on source or destination**; capacity flags honoured | Coaches can move athletes between any sessions and raise or lower `max_participants` on either. |
| **V6** | Medium | `staff_set_session_custom_slot_price`: coach allowed on own sessions | Coaches change a session's price. |
| **V7** | Medium | `staff_set_session_roster_slot_price` + RLS `session_roster_slot_prices_manager_or_session_coach_write` | Coaches change per-athlete prices in their sessions, directly or via RPC. |
| **V8** | Medium | `coach_add_athlete`: coach allowed on **any** session | Coaches can add athletes to sessions they don't manage. Inconsistent with remove/attendance/walk-in, which are ownership-checked. |
| **V9** | Low–Medium | `maintain_session_series_horizon`, `reconcile_series_duplicate_sessions`: coach-callable | System maintenance that creates (generation) or deletes (duplicate cleanup) sessions. Results are deterministic from manager configuration, but they're session mutations outside the manager role. |

## 3. UI controls to remove or restrict for coaches

| Control | Where | Change |
|---|---|---|
| "Create session" menu item | `src/components/GlobalQuickMenu.tsx` (coach items) | remove |
| Create-session route | `app/(app)/coach/create-session.tsx`; `src/lib/roleRouteAccess.ts` | deny for coaches (redirect to coach home) |
| "Add session" in the day sheet | `app/(app)/coach/sessions.tsx` (`onAddSession`), `src/components/DaySessionsSheet.tsx` | don't pass for coaches |
| "Edit session" button | `app/(app)/coach/session/[id].tsx` (~L630) | remove |
| Day-sheet tap on own session → manage screen | `DaySessionsSheet.goEdit` | always open the read-only coach session page |
| Coach manage screen (save, duplicate, series scope, price) | `app/(app)/coach/session/manage/[id].tsx` | deny route for coaches (keep the file for managers only if used; it isn't) |
| Delete own session in the day sheet | `DaySessionsSheet` (`ownAsCoach → canDelete`) | managers only |
| "Decrease group size" after removing a participant | `src/components/ParticipantAttendanceList.tsx` (~L243–310) | managers only |
| "Increase capacity" when adding to a full session | `src/components/AddParticipantToSessionModal.tsx` (`increaseSessionCapacity`, full-session choice) | managers only (coach sees "full", plus Q2) |
| Capacity options when moving a participant | `src/components/MoveParticipantSheet.tsx` | managers only; coach move per Q4 |
| Per-athlete rate chip (edit) | `src/components/RosterSlotRateChip.tsx` via `ParticipantAttendanceList` | read-only for coaches |
| Background horizon generation from the coach home | `app/(app)/coach/sessions.tsx` (`maintainSessionSeriesHorizon`) | stop calling (the cron and managers keep it current) |

**Today these coach flows show success while nothing changed** (RLS silently drops the direct UPDATE):
- "decrease group size" sets the new capacity locally;
- "increase capacity" continues as if it worked;
- the manage screen's save shows "Session saved".

After the fix, every remaining client write checks the server result. No success is shown without confirmation.

**Kept for coaches:** add/remove participants (own sessions), attendance, payment method (+ amount per Q1), session notes (Q3), the read-only pricing hub (already read-only), participant history.

## 4. Required database / RPC changes

One additive migration. Only coach permissions are tightened: **no RLS is weakened, manager and super-user behaviour is unchanged, and no signatures change**, so older PWA clients keep working. Every denial returns an explicit `{ ok: false, error: 'forbidden' }`, or an RLS error for direct writes, never a silent no-op where the function controls it.

1. `staff_delete_session_series_scope`: manager only. *(V1)*
2. RLS `session_series`: replace `session_series_staff_write` with manager-only INSERT/UPDATE/DELETE; keep staff SELECT. *(V2)*
3. `staff_create_session_series`: manager only. *(V3)*
4. `staff_update_session_series_scope`: manager only. *(V4)*
5. `staff_move_session_participant`: managers unchanged. Coaches per **Q4**: either denied, or allowed only when they manage **both** sessions **and** no capacity flag is set (otherwise `forbidden`). *(V5)*
6. `staff_set_session_custom_slot_price`: manager only. *(V6)*
7. `staff_set_session_roster_slot_price` + RLS `session_roster_slot_prices`: manager only. *(V7)*
8. `coach_add_athlete`: coaches only on sessions they manage (`coach_id = caller`), consistent with the other participant operations. *(V8, Q5)*
9. `maintain_session_series_horizon`, `reconcile_series_duplicate_sessions`: manager or system (cron/service role); coaches → `forbidden`. *(V9)*
10. Hardening: `REVOKE EXECUTE … FROM anon` on the session-mutation functions above. Verified first that no signed-out flow needs them.

**Rollback:** the migration ships with a tested down-script that restores the exact previous function bodies and policies, captured from production with `pg_get_functiondef` and `pg_policies` before applying.

## 5. Regression test plan

**A. SQL suite** on the local stack (new numbered suite following `supabase/tests/README.md`). Accounts: athlete, **coach A (session owner)**, **coach B (not owner)**, manager, super user. For **every** path in §1, functions **and** direct table writes under each role's JWT:
- Coaches: create, delete, edit, price, series rows, capacity via move, horizon and cleanup → **explicit failure**. Data unchanged, verified by row snapshots before/after.
- Coach A on own session: add/remove athlete, add/remove walk-in, attendance, payment method (+ amount per Q1), notes → **succeed**.
- Coach B on A's session → **fail**.
- Manager: every existing operation succeeds (create series, update this/future, delete this/future, prices, roster price, move with capacity, duplicate/clear day, open week, revert) → **regression guard**.
- Receipted payment still locked for coaches.
- No partial writes: multi-step functions roll back entirely on denial.

**B. Direct API tests** (real JWTs, PostgREST, isolated stack): `PATCH`/`DELETE`/`POST` on `training_sessions`, `session_series` and `session_roster_slot_prices`, plus each RPC, as coach A and coach B. Expect 0 rows or an RLS error, or `forbidden`; DB unchanged.

**C. UI tests** (Playwright, isolated stack): the coach UI shows none of the controls in §3, and the coach routes for create/manage redirect. Coach can still add/remove participants, mark attendance and record payment method. Manager UI smoke test of every session action. No success toast after any failed operation.

**D. Existing suites:** Jest, `tsc`, lint; existing SQL suites touching these functions (series, move, capacity row locking, receipt locks).

## 6. Recommended deployment order (each step needs your approval)

1. **Server migration first.** It closes V1–V9 immediately and is independent of the app version.
   - Old app versions: coach buttons still exist, but the server now refuses them with explicit errors.
   - Coaches lose session creation, which they've used (9 times). Tell them before or at release.
2. **Production verification, read-only:** catalog checks (function bodies, policies, grants), plus API checks with a **dedicated production coach test account** if you have one (to confirm).
3. **Client release** removing the coach controls (§3). This is independent of the performance branches.
4. **Monitor** for 24–48 h: activity log, edge 4xx/5xx, coach workflow errors.
5. **Rollback** if needed: the down-script for the server, `git revert` or a Render rollback for the client.

## 7. Decisions needed before implementing

- **Q1 Amount paid:** coaches currently record the **amount paid** as well as the method (attendance RPCs). Keep that, as the existing financial permission, or restrict coaches to the method only?
- **Q2 Over-capacity add:** coaches can add an athlete **beyond** capacity (`p_allow_over_capacity`) without changing capacity. Keep for coaches, or managers only?
- **Q3 Session notes:** keep coaches' existing ability to add/edit/delete **their own notes on their own sessions** (recommended: unchanged; not treated as session configuration)?
- **Q4 Move participant:** may coaches move an athlete between two sessions **they manage** (no capacity change), or is moving manager-only?
- **Q5 "Sessions they are authorized to manage"** = sessions where they are the assigned coach (`coach_id`). That's the current rule for remove/attendance/walk-ins. Confirm, so `coach_add_athlete` is aligned.
- **Production coach test account** for post-deployment API verification (yes/no)?
