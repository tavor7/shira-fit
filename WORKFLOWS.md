## Shira Fit — Workflows Map (source of truth for QA)

This file maps the end-to-end flows across **mobile (Expo)** + **Supabase RPCs/RLS**.
Use it as a checklist when changing navigation, permissions, or database logic.

### Roles

- **Athlete**: browses open sessions, registers/waitlists/cancels, views own sessions, profile/notifications.
- **Coach**: manages only their sessions (intended), takes attendance, adds/removes athletes/manual participants, session notes.
- **Manager**: full access to sessions, approvals, staff tools, reports; can optionally toggle **Athlete view** (preview).

### Global entry + auth

1. **Cold start** → `app/index.tsx`
   - If **no session** → go to `/(auth)/login`
   - If **session** but **profile missing** → retry once, otherwise show an error gate (should not bounce to login silently)
   - If **athlete pending** → `/(app)/pending`
   - Else route by role to sessions home (manager may route to athlete view if preview is enabled)

2. **Login** → `/(auth)/login`
   - Email + password via `supabase.auth.signInWithPassword`
   - On success, app loads `profiles` row and routes through `app/index.tsx`

3. **Signup** → `/(auth)/signup`
   - Creates Supabase Auth user
   - DB trigger inserts `public.profiles` row (pending athlete by default)

4. **Password reset**
   - Request reset → `/(auth)/forgot-password`
   - Apply new password → `/(auth)/reset-password` (web parses token hash)

### Athlete workflow

1. **Sessions calendar** → `/(app)/athlete/sessions`
   - Fetch sessions for a visible week range (calendar component emits week start/end)
   - If session is open: athlete can attempt `register_for_session(session_id)` RPC
   - If full: athlete can attempt `request_waitlist(session_id)` RPC

2. **Session detail** → `/(app)/athlete/session/[id]`
   - Show details + registration state
   - Optional: list participant names (intended to be limited to participants or staff)

3. **My sessions** → `/(app)/athlete/my-sessions`
   - List active registrations (and relevant info)

4. **Cancel**
   - Athlete cancels via `cancel_registration(session_id)` RPC
   - Cancellation should trigger waitlist notify automation (Edge/db trigger)

### Coach workflow

1. **Coach sessions** → `/(app)/coach/sessions`
   - Calendar + overview

2. **Session detail** → `/(app)/coach/session/[id]`
   - Add/remove athletes
   - Add/remove manual participants
   - Attendance + payment method edits
   - Session notes
   - Intended rule: coach can mutate only sessions where `training_sessions.coach_id = auth.uid()`

3. **Create session** → `/(app)/coach/create-session`
   - Create a new session for self

4. **Participant history** → `/(app)/coach/participant-history`

### Manager workflow

1. **Manager sessions** → `/(app)/manager/sessions`
   - Full calendar view (open/close visibility, create, edit)

2. **Session admin** → `/(app)/manager/session/[id]`
   - All operations coach can do, plus manager-only ops (delete session, bulk actions, etc.)

3. **Overview/dashboard** → `/(app)/manager/dashboard`
   - Weekly stats via `manager_weekly_stats(week_start)` RPC
   - Tabs: staff/users, trainer colors, roles, opening schedule

4. **Approve athletes** → `/(app)/manager/approve`
   - Approve/reject pending athlete profiles

5. **Reports**
   - `/(app)/manager/participant-history`
   - `/(app)/manager/coach-sessions-report`

6. **Athlete view (preview)**
   - Toggle from quick menu; routes to athlete sessions view but keeps manager session.

### Weekly opening automation (registrations)

- Sessions for the next calendar week (Sun–Sat) are opened at the configured opening weekday/time (UTC).
- Source(s):
  - Edge Function `supabase/functions/open-weekly-registrations`
  - SQL helper `open_next_week_sessions_if_due()` (should not be callable broadly if it mutates rows)

