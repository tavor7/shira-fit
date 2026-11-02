# Performance Phase 4 — attendance, startup gates, bundle, registration RLS, real-device plan (2026-11-02)

Branch `perf/phase4-attendance` (from `main` 00e5c96). Only §1 is implemented; §2-§4 are measured proposals.
Labels: **[M-local]** isolated perf stack (+190 ms modelled latency) · **[M-emu]** Chromium with 4× CPU throttling
(emulated mid-range phone) · **[M-prod]** production read-only · **[E]** estimate. No real-device numbers exist yet (§5).

## 1. Attendance taps (implemented, commit 5989cc4)

**Confirmed request sequence of one tap** (manager Session Detail, before) [M-local]:

| ms after tap | requests | why |
|---|---|---|
| 46 | `set_registration_attendance` | the write |
| 330-830 | 8: registrations, walk-ins, session row, roster prices, receipt locks, coverage → names → batch prices | roster's own reload (needed: authoritative money / coverage after the write) |
| 927-1,378 | 19: session row + tier price, waitlist ×3, cancellations ×3, notes ×3, the roster's 8 again | realtime echo of the same write (handler reloaded everything; `load()` and the roster's `onChanged` each reloaded waitlist / cancellations / notes again) |

The attendance RPCs write only the participant row (+ activity event; a trigger updates subscription coverage, which the
roster's own reload re-reads). Waitlist triggers fire only on cancellation / removal. So waitlist, cancellations, notes
and the session row cannot change because of an attendance write.

**Changes** (client only): realtime handlers receive the changed tables / rows (`null` = unknown → refresh everything);
manager Session Detail refreshes only what changed tables can affect; the roster reloads on realtime only when the changes
can make it out of date (`rosterChangesAreNews`: an UPDATE of an on-screen active row whose shown fields already equal
the new row is not news; inserts, deletes, cancellations, status changes, unknown rows / batches are); attendance /
payment / rate writes no longer trigger waitlist / cancellations / notes reloads (manager and coach).

| Measured [M-local] | Before | After |
|---|---|---|
| Requests per tap, manager | 28 | **10** |
| Requests per tap, coach (own session; no realtime on coach detail) | 12 | **9** |
| Background work after a tap (last request starts) | 1,302 ms | **865 ms** |
| Tapped row shows the new state | immediate (optimistic) | immediate (unchanged) |
| Manager sees own change confirmed | 427 ms | 321 ms |

**Functional verification** [M-local]:
- Two connected staff users + an athlete (`verify-attendance-realtime.mjs`): manager receives the coach's later change
  (1.8 s → 1.6 s), a new registration (1.3 s) and a cancellation incl. the cancellations list (0.9 s) — before and after
  identical. *Pre-existing (unchanged)*: coach Session Detail has no realtime subscription; it shows others' changes on
  reopen / refresh.
- After every tap the screen equals a fresh reload (all text, summaries, amounts, control states): manager and coach,
  Chromium and WebKit.
- compare-ui 20/20 identical; Jest 844 passed (+7 rosterRealtime), tsc clean, lint 0 errors.
- Database implications: none.

## 2. Startup / resume gate checks (proposal — low priority)

On every start and resume: `get_required_consents`, `get_address_collection_required`, `get_my_subscription_terms`,
`get_pending_manager_direct_message`, `system_client_reporting_enabled`, plus a profile read (6). Finding: **none of
the gates blocks the screen** — each renders nothing while loading and appears only when the server says it is required;
they run in parallel with the screen's own data. Consolidating them into one `get_app_gate_status()` (calling the same
server functions) would save ~4 background requests per start / resume but not move time-to-content. It needs a
migration and a shared client gate store (the hooks currently have different refresh triggers: terms on navigation /
60 s, consents on signup sync, DM on resume). Recommendation: **defer** unless real-device traces show resume contention.

## 3. JavaScript bundle (measured proposal — no change made)

Composition of the 4.3 MB (1.07 MB brotli) bundle, from the source map [M-local]:

| Part | Size |
|---|---|
| App code (components, screens, lib, routes, context) | ≈1.7 MB (40%) |
| Translations, Hebrew + English | 431 KB (10%) |
| Metro runtime / wrappers (unmapped) | 547 KB (13%) |
| expo-router | 436 KB · react-native-web + react-dom 450 KB · Supabase ≈240 KB |
| Native-only Expo modules (notifications, file system, updates) | ≈70 KB |

Cost today: download only on first install and after a release (assets are `immutable` since Phase 2). Every cold start
parses and runs the bundle: **0.20-0.28 s of script time; login visible at 0.50-0.70 s** [M-emu, 5 runs].

| Option | Gain [E] | Risk |
|---|---|---|
| A. Load only the active language's translations (inactive one on switch) | −≈215 KB raw (≈−50 KB brotli), a small part of the 0.2 s | low; language switch waits for one fetch |
| B. Web stubs for native-only modules | −≈70 KB | low-medium (push / file APIs used on web must keep working) |
| C. Route-level code splitting (Expo Router async routes) | initial bundle maybe −40-50%; ≤ ≈0.1 s of script time | first visit to each screen waits for a chunk (≈ one round trip); offline / deploy-skew handling; deep links need testing |

Recommendation: measure on a real iPhone first (§5). If cold start is dominated by script time there, do A (and B);
keep C for later.

## 4. Registration RLS (`reg_select`) — security-preserving proposal (not implemented)

Current policy: `is_super_user(auth.uid()) OR (user_id = auth.uid() AND NOT is_registration_hidden(...)) OR
(is_coach(auth.uid()) AND NOT is_registration_hidden_from_coach(...)) OR (is_manager(auth.uid()) AND NOT
is_registration_hidden_from_manager(...))`. All helpers are SECURITY DEFINER SQL (not inlinable): for **every row** it
runs three role lookups in `profiles` (same answer for every row) plus one hidden-registration lookup.

Proposed: the three role checks become init-plans — `(select public.is_super_user((select auth.uid())))` etc. —
evaluated once per query; the per-row hidden checks stay exactly as they are. Same functions, same arguments, STABLE →
same results.

| Query [M-local, rolled back] | Current | Proposed |
|---|---|---|
| Staff reading all registrations (manager / coach) | 68.5 / 41.9 ms | 12.9 / 15.0 ms |
| Registrations of upcoming sessions (alerts shape) | 2.2-2.9 ms | 0.85-1.85 ms |
| Own registrations, roster of one session | 0.02-0.3 ms | unchanged |

Equivalence: visible-row fingerprints identical for **all 163 users** (157 athletes, 3 coaches, 2 managers, super user)
on four query shapes (all, roster, own, athlete calendar which nests this policy). Edge cases to add to the suite before
release: pending / disabled athletes, hidden-from-athlete / coach / manager rows, unhidden rows, no-profile callers.
Migration safety: md5 precondition on the current expression (`79f246da…`), explicit new expression, post-check, rollback
script restoring the original (same pattern as 20261101091000). Production impact [E]: staff broad reads 2-3.5× the
local numbers.

## 5. Real-device measurement (instructions; no device results yet)

Instrumentation is inert unless enabled per device, records only endpoint labels and timings (no ids, URLs or data), and
sends nothing anywhere. **Home Screen web apps keep storage separate from Safari**, so enable it where you will measure.

*Option 1 — Safari tab (no Mac needed):*
1. Open `https://shira-fit-mobile-web.onrender.com/?sf_perf=1` in Safari and log in. A ⏱ button appears.
2. Run the journeys below, then ⏱ → **Copy JSON** and send it to me. ⏱ → **Clear** between journeys if you like.

*Option 2 — Home Screen app (closest to daily use; needs a Mac + cable):* iPhone Settings → Safari → Advanced → Web
Inspector ON; on the Mac, Safari → Develop → [iPhone] → Shira Fit; in the console run
`localStorage.setItem('sf_perf','1')`, then close and reopen the app. Use ⏱ as above.
(`?sf_perf=0` or `localStorage.removeItem('sf_perf')` turns it off.)

Journeys (each 3×, read-only except attendance on a real session you would mark anyway):
1. Cold start: swipe the app away, reopen, wait for the calendar.
2. Open a session from the calendar; go back.
3. (Staff) mark attendance for a few participants.
4. (Manager) menu → Overview → Month → Global; menu → Sessions.
5. Repeated menu navigation (10 taps) then Back.
6. Leave the app for > 1 minute and return.

These numbers will decide between §2 / §3 / §4 priorities.

## Proposed release sequence

1. **Attendance (this branch)** — client only, independent; ready for your approval.
2. Real-device traces (§5) — before deciding §2 / §3.
3. Registration RLS (§4) — separate branch, migration + suite 204, separate approval.
4. Bundle option A (± B) if §5 shows script time matters; gates (§2) only if resume contention is visible.
