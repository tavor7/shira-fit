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

### Account deletion (App Store / compliance)

- **In-app**: Profile → **Account** → “Delete account” (calls Edge Function `delete-account` with the user’s JWT; then signs out).
- **Server**: `supabase/functions/delete-account` — uses the service role to `auth.admin.deleteUser` for the **same** user as the JWT. **Managers** are blocked. **Coaches** are blocked if any `training_sessions` row has `coach_id` = that user (database `ON DELETE RESTRICT` on sessions).
- **Deploy**: `npm run supabase:deploy-delete-account` from `mobile/` (or `supabase functions deploy delete-account` from repo root). Config: `supabase/config.toml` entry `delete-account`.

### EAS build + OTA (Expo)

- **Init** (once, from `mobile/`): `npx eas-cli init` — links the app to an Expo project and can write `extra.eas.projectId` into the config.
- **Secrets** (for production builds on EAS): set `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN` in the EAS project (e.g. `eas env:create` / dashboard) so they are not only in your local `.env`.
- **Builds**: `npm run eas:build:ios` / `npm run eas:build:android` (or `eas build` with the `production` profile in `mobile/eas.json`). `runtimeVersion` uses **app version** policy in `app.json` for `expo-updates` compatibility.
- **Updates** (optional): `npm run eas:update` after configuring EAS Update.

### Push notifications (Expo + native stores)

- **iOS**: In [Expo credentials](https://expo.dev), add an **Apple Push Key** (APNs) for the bundle id `com.shirafit.app`.
- **Android**: Add **FCM** (v1) for the project; place `google-services.json` in `mobile/` (gitignored) and set `android.googleServicesFile` in `app.json` if you use the config property, or follow EAS Android FCM setup in the Expo docs. Waits on **remote** Expo push until `extra.eas.projectId` is set and credentials are complete; **local** scheduled reminders still work with notification permission.

### Store listings — privacy & data (checklist)

- **Public URL**: In-app link resolves via `getPrivacyPolicyUrl()` — **`EXPO_PUBLIC_PRIVACY_POLICY_URL`** (see `mobile/app.config.js`) overrides the marketing fallback. The built-in policy screen lives at **`/privacy-policy`** in the Expo web export (Render static site); after deploy, set e.g. `https://<your-render-service>.onrender.com/privacy-policy`.
- **Apple — App Privacy**: Declare data collected (e.g. email, phone, account info, **photos/videos: No**, **usage**: match reality). Push tokens / profile fields are typically “linked to the user.” No third-party ad SDK → no tracking declaration for ads.
- **Google Play — Data safety**: Align with the same: account info, contact (phone), optional messages for notifications; encryption in transit (HTTPS to Supabase).

### App Review notes (template)

Fill in for Apple “Notes” and Play “Instructions”:

- **Privacy policy URL**: same as `privacyPolicyUrl` above (must be live).
- **Demo accounts** (passwords set in Supabase Auth):
  - Athlete (approved): `________`
  - Coach (optional): `________`
  - Manager (optional): `________`
- **Steps to test**: log in → browse sessions → open profile → notifications / delete account (use a throwaway athlete account for deletion tests).

