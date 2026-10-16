# Coach session permissions — production readiness (2026-10-16)

| | |
|---|---|
| Branch | `security/coach-session-permissions` (local, not pushed) |
| Commits since the implementation report | `2907716` payment-correction / no-show tests · `a33e8c9` "Session full" message for a server-side capacity refusal · `5786e9a` UI test made independent of the restored last route |
| Status | **ready for your approval. Nothing deployed, nothing applied to production.** |

## 1. Owner decisions of 2026-10-15, as implemented

| Decision | Implementation | Proof |
|---|---|---|
| Coaches may **correct or clear** an unreceipted payment on their own session; audited; validations intact; no effect on prices or other records | **Existing behaviour, kept.** The attendance RPCs only change that row's attendance and payment fields, validate the amount (≥ 0), and log every change with from/to values in `user_activity_events`. | 179: record cash 50 → correct to bit 40 → clear; each step stored and logged ("from 50.00 to 40.00"). Amount owed and session price unchanged. Walk-in correction logged. |
| **Receipted payments** stay protected | existing receipt-lock trigger | 164: **34 / 34**, including a receipt issued concurrently with a coach edit |
| Coaches may keep marking an absent athlete as **chargeable**; every charge auditable; no new rules | **Existing behaviour, kept.** No calculation was changed. | 179: absent + no-show charge stored and logged (`charge_no_show` → true) |

## 2. Verification

| Area | Result |
|---|---|
| **V1–V10 restrictions** | 179 (database, real `authenticator` role with JWT): **147 / 147**. 180 (real HTTP, GoTrue sign-in + PostgREST): **95 / 95**. Both suites **fail on an unpatched copy** of production (180: 44 failures), so they detect the vulnerabilities. |
| **Manager functionality unchanged** | 179 / 180 manager and super-user paths: create series, edit this / future, prices, roster price, move with capacity change, over-capacity add, horizon, delete this / future, direct writes |
| **Permitted coach workflows** | add / remove athlete and walk-in, move between own sessions, attendance, payments (incl. corrections), no-show charge, own notes: all pass. Browser test on the security build and on the combined (security + performance) build: **20 / 20, 8 consecutive runs** (Chromium and WebKit). |
| **Payment integrity** | 163 coach financial access **89 / 89**, 164 receipt lock **34 / 34**, 165 compensation **38 / 38**; cron roster copy 135 passes |
| **No collateral regression** | every other local-stack suite run with and without the migration on the same database: identical results |
| App | Jest **733 / 733**, `tsc` clean, lint unchanged |

**Fixed during this review:**
- When the server refused an athlete add because the session was full, the athlete path showed the raw code "full". It now shows "Session full", as the walk-in path already did.
- The UI test was flaky because of the app's restore-last-route feature. That was a test-harness issue, now fixed.

## 3. Production compatibility and prerequisites (checked read-only, 2026-10-16)

| Check | Result |
|---|---|
| The 11 replaced functions are still the reviewed source | **yes** (fingerprint `98d64660…` = reviewed). The migration also enforces this itself and aborts otherwise. |
| Policies and TRUNCATE grants unchanged since review | **yes** (`3769ade1…`, `0240489f…`) |
| Production migration history = repository | **identical**: the same 302 versions (fingerprint `4e10e415…`), latest `20261019100000`. **A push applies exactly one migration, this one.** |
| Coach usage, last 60 days | attendance / payments (43 events) and walk-in adds (2): unaffected. **Session creation: 9 events by 2 coaches (latest 2026-10-12): this release removes it.** No coach edits or deletes in that period. |
| Daily horizon cron | runs as its own entry point, unaffected (last success today, 0 failures in 14 days) |
| Old PWA versions | same function signatures. Refused calls return `forbidden` / `full`; nothing changes in the database. |

## 4. Deployment and verification checklist

**Before** (read-only):
- [ ] Re-run the three fingerprint queries above. They must still equal the reviewed values. (The migration refuses otherwise anyway.)
- [ ] Confirm no deploy of other migrations is pending (production history = repository, as above).
- [ ] Tell coaches that session creation is now done by managers.
- [ ] Choose a quiet time. The migration is metadata-only: function and policy replacement, no data rewrite, sub-second.

**Apply** (your explicit approval required):
- [ ] Apply `20261020100000_coach_session_configuration_manager_only.sql` as a single migration.

**Verify immediately** (read-only):
- [ ] Function sources fingerprint = `8bd61ec2dff7de83d0ebbdef265b7b91`
- [ ] Policies fingerprint = `0c5b659721673863279885eb72043aba`
- [ ] TRUNCATE for anon / authenticated on the 7 session tables = none
- [ ] EXECUTE grants (order-independent fingerprint) = `86f6a28e5b26540b1a507aec880566b8`
- [ ] Optional, with a dedicated production coach test account: an API call to `staff_delete_session_series_scope` on a non-existent session id returns `forbidden` (proves the guard without touching data)

**Then:**
- [ ] Deploy the app (coach UI) via Render.
- [ ] Hard-refresh a coach PWA and confirm: no Create / Edit / Delete; attendance and payments work.
- [ ] Monitor for 24–48 h:
  - no coach `session_*` configuration events in the activity log;
  - edge 4xx/5xx for the affected RPCs;
  - coach errors in system monitoring;
  - the daily horizon cron.

## 5. Remaining risks

1. **Coaches lose session creation**, which they used. This is the policy, but it's a visible change, so communicate it before release.
2. **Old PWA clients** (until refreshed) still show the removed buttons. The server refuses each one explicitly. One old flow ("decrease group size" after a removal) updates the number on screen without saving it, until the app is reloaded. The data is correct.
3. **Add modal race (pre-existing, minor):** if a staff member taps an athlete in the first moments after opening the add modal on a full session, they get "Session full" instead of the manager's increase / over-capacity choice. A manager simply taps again. No wrong data is possible.
4. **Not in this release's scope (unchanged):**
   - coaches' access to account / participant-data functions (`staff_set_account_disabled`, `staff_update_profile`, …);
   - TRUNCATE grants on non-session tables (not reachable through the API).
5. **Rollback** reopens V1–V10. Prefer a targeted corrective migration; the full rollback only with your explicit approval (tested: restores production exactly).
