# Coach session permissions — implementation report (2026-10-15)

| | |
|---|---|
| Branch | `security/coach-session-permissions` (from `main` ad0d693; local only) |
| Commits | `09e3e2d` migration + rollback · `aac09d8` tests · `775bd4e` suites 163/164 · `0159679` coach UI · `fc4001a` guard-comment dates |
| Status | implemented and tested on an isolated local Supabase stack. **Not merged, not pushed, not deployed, nothing applied to production.** |
| Policy | your final decisions Q1–Q5 and Part B (2026-10-15) |

## 1. Summary

**Server: one migration.** `supabase/migrations/20261020100000_coach_session_configuration_manager_only.sql`
- Session configuration becomes manager-only.
- Coaches keep only participant, attendance, payment and own-note operations on sessions assigned to them.
- No function signatures change, no data changes, and no RLS rule is loosened.

**App: coach UI.** Controls that the server now refuses are removed, and their routes redirect home.

**Tests:**
- Two new database suites (179, 180) and a browser test.
- Existing suites updated where they asserted the old behaviour (135, 163, 164, 165).

**Two corrections to my audit:**
- **V8 was overstated.** `coach_add_athlete` already checked ownership, inside `_coach_add_athlete_core`.
- **V5 was overstated.** `staff_move_session_participant` already required the coach to manage **both** sessions.

What was actually wrong in both cases was capacity: coaches could add or move over capacity, and raise or lower capacity during a move. That is fixed. The tests prove the ownership checks: coaches are refused on another coach's sessions both before and after the fix.

**Found while fixing (V10):** a coach could move a walk-in between their sessions by updating `session_manual_participants.session_id` directly. That bypassed the capacity, subscription and move checks. Reproduced on the unpatched database, now closed.

## 2. Exact files changed

| File | Change |
|---|---|
| `supabase/migrations/20261020100000_coach_session_configuration_manager_only.sql` | the migration (§3) |
| `docs/security/rollback/20261020100000_…_ROLLBACK.sql` | security-sensitive rollback (§9). It sits outside `supabase/migrations` on purpose. |
| `supabase/tests/179_coach_session_permissions_tests.sh` | new: database-level authorization suite (132 checks) |
| `supabase/tests/180_coach_session_permissions_api_tests.sh` | new: real HTTP suite (GoTrue sign-in, PostgREST REST and RPC; 95 checks) |
| `supabase/tests/135_…`, `163_…`, `164_…`, `165_…` | updated where they asserted behaviour this fix deliberately changes (§6) |
| `docs/security/harness/ui-coach-permissions.mjs` | new: browser test (Chromium and WebKit) |
| `mobile/app/(app)/coach/session/[id].tsx` | removed "Edit session". Note composer and note edit/delete only on sessions assigned to the coach. Flag renamed `canManageParticipants`. |
| `mobile/app/(app)/coach/sessions.tsx` | no "Add session"; no longer calls `maintain_session_series_horizon` |
| `mobile/src/components/DaySessionsSheet.tsx` | coach tap opens the read-only session page (not the manage screen); delete is manager-only |
| `mobile/src/components/GlobalQuickMenu.tsx` | coach "Create session" removed |
| `mobile/src/lib/roleRouteAccess.ts` (+ new test) | `/coach/create-session` and `/coach/session/manage/*` are denied to coaches. The existing guard redirects them home. |
| `mobile/src/components/AddParticipantToSessionModal.tsx` | on a full session, a coach sees "Session full", without the increase / over-capacity options. Capacity increase checks the server result. |
| `mobile/src/components/MoveParticipantSheet.tsx` | for coaches: full destination says "Pick a session with a free place", no capacity options, no "decrease group size". Capacity writes check the server result. |
| `mobile/src/components/ParticipantAttendanceList.tsx` | "Rate" (per-athlete price) and "decrease group size" are manager-only; the capacity write checks the server result |
| `mobile/src/i18n/translations.ts` | one new string (en/he): `moveParticipant.fullMessageCoach` |

## 3. Migration contents and affected database objects

**How the migration is built:**
- Every replaced function is the **exact production source**. The reviewed definitions were md5-verified identical to production on 2026-10-15.
- **Only the marked guard lines change.** Diff per function: 3–8 lines.
- **Precondition:** the migration aborts and changes nothing unless all 11 functions are byte-identical to the reviewed production source. Verified: a second run is refused with "precondition failed, nothing changed".
- `CREATE OR REPLACE` keeps owner, `SECURITY DEFINER`, `search_path` and signatures. Older PWA versions call the same functions and get `{"ok":false,"error":"forbidden"}` (or `"full"`) instead of a change.

| # | Object | Before | After |
|---|---|---|---|
| V1 | `staff_delete_session_series_scope` | any coach, **any** session | manager only |
| V2 | RLS `session_series_staff_write` (ALL) | any coach, any series | replaced by manager-only insert / update / delete; staff keep SELECT |
| V3 | `staff_create_session_series` | any coach, for any coach | manager only |
| V4 | `staff_update_session_series_scope` | coach on own sessions (time, capacity, duration, open, hidden, kickbox, price; this / future) | manager only |
| V5 | `staff_move_session_participant` | coach moving between own sessions could raise or lower capacity, or move over capacity | a coach (still required to coach both sessions) passing any capacity flag → `forbidden`, refused **before any write**. Managers unchanged. |
| V6 | `staff_set_session_custom_slot_price` | coach on own sessions | manager only |
| V7 | `staff_set_session_roster_slot_price` + RLS `…_manager_or_session_coach_write` | coach on own sessions (RPC and direct) | manager only (RPC and RLS) |
| Q2 | `_coach_add_athlete_core`, `add_manual_participant_to_session` | coach could pass `p_allow_over_capacity` | for a non-manager the flag is ignored and capacity always applies (`"full"`). Ownership was already enforced. System paths (no actor, e.g. the cron roster copy) are unchanged. |
| V9 | `maintain_session_series_horizon`, `reconcile_series_duplicate_sessions` | any coach | manager only. The daily cron (`cron_maintain_session_series_horizon`, 02:15 UTC) is unaffected; production last ran it OK today, with 0 failures in 14 days. |
| V10 | RLS `session_manual_participants_update_staff` | coach could UPDATE walk-in rows of own sessions directly, including `session_id` | replaced by manager-only UPDATE. Coaches write walk-in attendance and payments through the RPCs, which validate and log. **No client version ever used the direct path** (checked in git history). |
| Q3 | `delete_session_note` + RLS note update/delete | a coach could edit or delete their own note after the session was reassigned | also requires the session to be assigned to them now (as `update_session_note` already did) |
| — | EXECUTE on the 11 functions above | `PUBLIC` and `anon` could execute them; the internal `auth.uid()` checks rejected the call | revoked from `PUBLIC` and `anon`; kept for `authenticated` and `service_role` |
| — | TRUNCATE on 7 session tables | granted to `anon` and `authenticated` (TRUNCATE bypasses RLS; not reachable through PostgREST) | revoked |

**Unchanged on purpose:**
- **Attendance and payment functions** (`set_registration_attendance`, `set_manual_participant_attendance`). They already enforce assigned-coach ownership, validate amounts, keep method and amount separate, log every change, and are blocked by the receipt lock once a receipt exists.
- **Remove participant** (already ownership-checked).
- **`open_next_week_sessions_if_due`** (schedule-driven, applies manager configuration).
- **`super_user_*`** functions.

## 4. Permission matrix — before / after

✅ allowed · ❌ refused · **bold** = changed by this fix. "Own" means a session where `coach_id` is the coach.

| Operation | Athlete | Coach, own session | Coach, other's session | Manager / super user |
|---|---|---|---|---|
| Create session or series | ❌ / ❌ | ✅ → **❌** | ✅ → **❌** | ✅ / ✅ |
| Delete session (this / future) | ❌ / ❌ | ✅ → **❌** | ✅ → **❌** | ✅ / ✅ |
| Date, time, duration, capacity, open/close, hidden, kickbox | ❌ / ❌ | ✅ → **❌** | ❌ / ❌ | ✅ / ✅ |
| Session price / per-athlete price | ❌ / ❌ | ✅ → **❌** | ❌ / ❌ | ✅ / ✅ |
| Recurring series rows (direct) | ❌ / ❌ | ✅ → **❌** | ✅ → **❌** | ✅ / ✅ |
| Reassign coach / coach pay | ❌ / ❌ | ❌ / ❌ | ❌ / ❌ | ✅ / ✅ |
| Horizon generation / duplicate cleanup | ❌ / ❌ | ✅ → **❌** | ✅ → **❌** | ✅ / ✅ (+ cron) |
| Add athlete or walk-in | own registration only | ✅ within capacity; over capacity ✅ → **❌** | ❌ / ❌ | ✅ (incl. over capacity) |
| Remove athlete or walk-in | own cancellation only | ✅ / ✅ | ❌ / ❌ | ✅ / ✅ |
| Move participant | ❌ / ❌ | between own sessions ✅ / ✅; with capacity change or over capacity ✅ → **❌** | ❌ / ❌ | ✅ (incl. capacity options) |
| Attendance, amount paid, payment method | ❌ / ❌ | ✅ / ✅ (receipted payments locked) | ❌ / ❌ | ✅ / ✅ |
| Walk-in row by direct table update | ❌ / ❌ | ✅ → **❌** (use the RPC) | ❌ / ❌ | ✅ / ✅ |
| Own notes: add / edit / delete | ❌ / ❌ | ✅ / ✅; after reassignment, edit/delete ✅ → **❌** | ❌ / ❌ | ✅ / ✅ |
| Anonymous (signed out) | — | — | — | every function above: internal `not_authenticated` → **no EXECUTE** |

## 5. Results for V1–V10

Each vulnerability was **first reproduced on the unpatched database**: a local stack whose functions were md5-identical to production. It was then tested after the fix.

| # | Unpatched (reproduced) | Patched |
|---|---|---|
| V1 | coach deleted own **and another coach's** session (`{"ok":true}`), and a series occurrence | refused for both coaches, athlete and anon (RPC and direct DELETE); manager and super user delete this / future ✅ |
| V2 | coach inserted, updated, ended own series directly; coach C2 rewrote C's series `coach_id` | all refused (RLS); manager direct write ✅ |
| V3 | coach created series for self **and for another coach** | refused (self, one-off, other coach; RPC and direct INSERT) |
| V4 | coach changed time, capacity, duration, open, hidden, price, and "this and future" | each refused separately; manager this / future ✅ |
| V5 | coach raised the destination capacity during a move (`ok`); moved a walk-in over capacity (`ok`). Moves into or out of another coach's session were **already refused**. | every capacity flag refused; a full destination → `full`; coach move between own sessions without flags ✅ with capacities unchanged; manager move with capacity increase ✅ |
| V6 | coach set and cleared own session price | refused |
| V7 | coach inserted a roster price directly | refused (RPC and RLS); manager ✅ |
| V8 / Q2 | coach added an athlete **over capacity** (`ok`). Adding to another coach's session was **already refused**. | over-capacity → `full` (athlete and walk-in); manager over capacity ✅ |
| V9 | coach ran horizon generation and cleanup | refused; manager ✅; cron path unchanged (suite 135 T1–T5) |
| V10 | coach moved a walk-in to another session by direct `UPDATE … set session_id` (1 row) | 0 rows (RLS) for session, participant and payment columns |
| Q3 | (note after reassignment) | former coach can't edit or delete the note (RPC and direct); own notes on own session ✅ |

**After every group of refusals, a snapshot of all session, series, occurrence, registration, walk-in, roster-price, note and waitlist rows of both test coaches was identical.** So no refused call changed data, including partial writes.

**Concurrency (last place in a 1-place session):**

| Race | Before | After |
|---|---|---|
| Two concurrent coach adds, one passing over-capacity | **2 of 1 places filled** | exactly 1; the second gets `full` |
| Coach add racing an athlete's self-registration | — | exactly 1 (the session row lock serializes them) |

## 6. Test results

| Suite | Unpatched | Patched |
|---|---|---|
| **179** database authorization (real `authenticator` connection, JWT claims; anon, athlete, coach assigned, coach not assigned, manager, super user) | many failures: each vulnerability reproduced | **132 / 132** |
| **180** direct API (GoTrue sign-in + PostgREST REST and RPC; anon, athlete, coach assigned, coach not assigned, manager, super user) | **44 failures** (vulnerabilities reachable over HTTP) | **95 / 95** |
| **Browser test** (coach and manager, Chromium + WebKit) | — | **20 / 20** each |
| 135 cron-safe roster copy | — | all passed (T9 now expects anon to lack EXECUTE) |
| 163 coach financial access | — | **89 / 89** |
| 164 receipted payment lock (incl. concurrent receipt issuance) | — | **34 / 34** |
| 165 coach compensation | — | **38 / 38** (its "coach edits own session time" is now a refusal) |
| Jest | — | **733 passed**, 8 skipped (includes 10 new route-access tests) |
| `tsc` | clean | clean |
| Lint | — | identical warnings before / after in every edited file |

**What the browser test covers:**
- **Coach:** no "Create session"; the create and manage URLs redirect; no "Edit session"; full session → "Session full" with no increase / over-capacity options, and still 1/1 in the database; no "Rate"; moving into a full session offers no capacity options; the day view has no "Add session" or delete; adding to own session works and is stored.
- **Manager:** "Rate" and "Increase capacity" are still offered.

**Other existing suites:**
- I ran the whole local-stack set (122–178).
- Failures were investigated by running the same suites with the migration **rolled back** on the same database. Every failure was identical with and without the migration, so all are pre-existing or environmental:
  - **124–129:** fixtures predate a required `gender` column.
  - **146–147:** need a fresh database.
  - **162:** a signup-address check.
  - **175:** counts a shared notification table.
  - **178:** fixture.
- With receipts configured on the local stack, 163 and 164 pass in full.
- **No suite regressed.**

## 7. Payment and participant-management regression

**Payments (Q1):**
- A coach records attendance with a **partial** amount (7.50) and a method on their own session.
- The stored fields stay separate: `attended`, `payment_method`, `amount_paid`, `payment_recorded_by`.
- **The amount owed (`session_billing_price_ils`) is unchanged** by recording a payment. The session price is untouched. The change is written to `user_activity_events` with from/to values.
- Walk-in payment via the RPC ✅. Another coach's session ❌.
- After a receipt is issued, the coach can't change amount, method or unpaid status (suite 164).

**Participants:** a coach can do the following on own sessions:
- add and remove an athlete;
- add and remove a walk-in;
- move between own sessions, with both capacities unchanged.

The manager keeps all of these, plus the capacity options.

## 8. Remaining security concerns (not changed here)

1. **Coach can correct or clear a recorded, unreceipted payment on their own session.** For example, re-saving with another amount, or "unset". That's today's authorization, kept as is:
   - the attendance RPC allows it;
   - every change is logged with from/to values;
   - receipted payments are locked.

   If "must not modify or delete previously recorded payments" should mean *never after first entry*, the attendance RPCs need a further rule. Tell me and I'll scope it.
2. **No-show charge.** Marking a participant absent **with** a no-show charge (`charge_no_show`) creates a debt. It's part of the existing coach attendance workflow, so I kept it. Restricting it would be a separate decision.
3. **Outside the session scope (from the audit, unchanged):** coaches can call `staff_set_account_disabled`, `staff_update_profile`, `staff_update_manual_participant` and `upsert_manual_participant` (account and participant data).
4. **TRUNCATE** is still granted to `anon` / `authenticated` on other tables. It isn't reachable through PostgREST. This matches the pending "TRUNCATE grants" finding; it's revoked here only for the 7 session tables.
5. **Old PWA versions** keep showing the old controls until they update. The server refuses them explicitly, so nothing changes in the database. Some old flows, however, show an error toast (or, for the old "decrease group size", update the number on screen without saving it) until the new client is loaded.
6. **Dead coach screens.** `coach/create-session.tsx` and `coach/session/manage/[id].tsx` remain in the codebase but are unreachable for coaches. They could be deleted in a follow-up.

## 9. Recommended production deployment sequence (each step needs your approval)

1. **Pre-checks (read-only):**
   - the 11 function sources still have the reviewed md5 (the migration also enforces this itself);
   - no new coach-created sessions or series since review (activity log).
2. **Tell coaches:** they can no longer create sessions. They have used this: 9 coach-created sessions in production.
3. **Apply the migration** (one transaction). Old clients keep working, and configuration attempts get explicit errors.
4. **Read-only verification:**
   - catalog fingerprints (policies, grants, function sources);
   - the API checks of suite 180's refusals using a **dedicated production coach test account**, if you provide one. Refusals only, so no production data is changed.
5. **Deploy the app** (coach UI changes). This is independent of the performance branches.
6. **Monitor for 24–48 h:**
   - activity log (no coach configuration events);
   - edge 4xx/5xx for the affected RPCs;
   - coach workflow errors in system monitoring;
   - the daily horizon cron.

**Ordering note:** the security branch is based on `main`. `app/(app)/coach/sessions.tsx` is also changed by performance Step 3, so whichever merges second will need a small conflict resolution in that file.

## 10. Rollback and recovery

- **Preferred:** if a legitimate workflow regresses, a **targeted corrective migration** that re-enables exactly that path while keeping V1–V10 closed. Example: allow one specific operation for coaches on their own sessions only.
- **Full rollback** (`docs/security/rollback/…_ROLLBACK.sql`):
  - **Security-sensitive.** It **reopens V1–V10**. Apply only with your explicit approval.
  - Tested locally. After it runs, policies, TRUNCATE grants and all function sources are **byte-identical to production**, and EXECUTE grants are the same set.
  - It has its own precondition (it only runs on exactly the migrated versions).
  - The migration re-applies cleanly afterwards.
- **App:** `git revert` of the UI commit, or a Render rollback. The old UI with the new server shows explicit errors rather than false success for most actions.
- **Data:** the migration changes no data, so there's nothing to restore.
