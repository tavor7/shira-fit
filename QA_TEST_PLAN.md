## Shira Fit — Manual QA Test Plan

Run this after any change to **Supabase migrations**, **Edge Functions**, or **mobile navigation/UX**.

### Preconditions

- Supabase project created and **all migrations applied in order** (oldest → newest).
- Edge Functions deployed:
  - `open-weekly-registrations`
  - `notify-waitlist`
- `CRON_SECRET` set in Edge Function secrets.
- Cron configured to call `open-weekly-registrations` (per README).
- At least:
  - 1 manager user (`profiles.role = 'manager'`, `approval_status = 'approved'`)
  - 1 coach user (`profiles.role = 'coach'`, `approval_status = 'approved'`)
  - 2 athlete users (`profiles.role = 'athlete'`; at least one approved)
- A few `training_sessions` rows exist across:
  - current week
  - next week (Sun–Sat)
  - a hidden session (`is_hidden = true`)

### A. Auth + profile bootstrap

1. **Sign up** as a new athlete.
   - Expected: user lands on `Pending` gate (approval pending).
2. **Manager approves** the athlete.
   - Expected: after refresh/relogin, athlete can access sessions.
3. **Profile load failure UX**
   - Temporarily block Supabase network (or simulate schema mismatch).
   - Expected: you see **“Profile unavailable”** screen with **Retry** and **Sign out** (no silent redirect loop to login).

### B. Athlete browse + registration

1. Open `Athlete → Sessions`.
   - Expected: non-hidden sessions render; closed sessions appear but show closed status where applicable.
2. Open an **open** session detail.
   - Tap **Register**.
   - Expected: RPC succeeds, UI shows registered state, reminders scheduled, count increases.
3. Fill a session to capacity, then open the session detail.
   - Expected: Register disabled; waitlist action available.
4. Tap **Notify if spot opens**.
   - Expected: RPC succeeds, UI indicates “On waitlist”.
5. Participant names privacy:
   - While not registered and not on waitlist, open session detail.
   - Expected: Participant card shows “shown after you register/join waitlist”.
   - After registering/waitlisting, expected: names list is available (non-empty if others registered).

### C. Cancellation + waitlist notify

1. Athlete registers to a full session; Athlete B joins waitlist.
2. Athlete cancels registration.
   - Expected:
     - cancellation RPC ok
     - registration status updates to cancelled
     - waitlist notify triggers (Edge logs show a request; device receives push if configured)

### D. Staff permissions + “coach owns session”

1. Create sessions for **Coach A** and **Coach B**.
2. As Coach A:
   - Try to add an athlete to **Coach B’s** session.
   - Expected: RPC returns forbidden.
3. As Coach A:
   - Add/remove athletes and manual participants to **Coach A’s** session.
   - Expected: succeeds.
4. As Manager:
   - Add/remove athletes and manual participants to any session.
   - Expected: succeeds.

### E. Weekly opening (single source of truth)

1. Confirm mobile no longer calls the SQL opener opportunistically.
2. Trigger `open-weekly-registrations` manually (HTTP request with `Authorization: Bearer CRON_SECRET`).
   - Expected:
     - sessions outside next-week window are closed
     - hidden sessions in next-week window remain closed
     - next-week sessions open only after the configured open time

### F. Manager dashboard performance sanity

1. Load `Manager → Overview`.
   - Expected: stats load quickly and remain responsive as session counts grow.
2. Verify fields:
   - Avg fill, cancellations, no-shows, sessions count, payments-by-method.

### G. Navigation sanity

1. In manager flows:
   - Approve menu item should always be present (badge when pending > 0).
   - Badge count updates when navigating back from approval screen.
2. Back behavior:
   - Open a session detail → open a nested sub-screen (edit/manage/etc).
   - Expected: header back behaves like normal back (pop) whenever stack history exists; falls back to sessions home only when it doesn’t.

### Optional: Database integrity spot-checks (SQL editor)

- Verify athletes cannot directly insert registrations:
  - Attempt direct insert as authenticated user should fail due to missing insert policy; RPC should still work.
- Verify athletes cannot enumerate participant names without being involved:
  - Calling `list_session_participants` on a session they are neither registered nor waitlisted for should return empty.

