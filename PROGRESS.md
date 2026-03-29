# Shira Fit — Implementation Progress

## Accounts (see README)

- [ ] **Required now:** Supabase project (DB, Auth, Edge Functions, Cron)
- [ ] **Can wait:** Expo EAS (production builds), Apple/Google push certs (dev works with Expo Go)

## Checklist

- [x] PROGRESS.md + implementation plan
- [x] Supabase SQL schema + RLS + RPCs
- [x] Edge Function: weekly registration open (Thu 08:00)
- [x] Edge Function: waitlist notify (spot opened)
- [x] Expo mobile: auth, athlete, coach, manager flows
- [x] Web admin dashboard (Vite)
- [x] README + .env.example

## Stop / external setup (you must do)

1. **Supabase project** + run migration SQL + promote first user to **manager** (see README).  
2. **Edge Function secrets:** `CRON_SECRET` + deploy both functions.  
3. **Cron:** Thursday 08:00 → `open-weekly-registrations` with `Authorization: Bearer CRON_SECRET`.  
4. **Waitlist push:** After cancel, call `notify-waitlist` (same auth) or automate via webhook.  
5. **Expo push token:** Optional — store in `profiles.expo_push_token` after `expo-notifications` permission.

## Assumptions (not in spec)

1. **Login identifier:** Supabase Auth uses email; **username** is stored on `profiles` for display. Signup collects email + password + profile fields.
2. **Session “day”:** Derived from `session_date` (PostgreSQL `date`); no separate day column.
3. **Coach assignment:** `training_sessions.coach_id` → `profiles.user_id` where `role = coach` (or manager acting as coach).
4. **Waitlist notify:** Database webhook → Edge Function (documented in README); fallback manual trigger for dev.

## Phases (from spec)

| Phase | Status |
|-------|--------|
| 1 Setup | Done |
| 2 Auth + profiles + pending | Done |
| 3 Athlete sessions + register | Done |
| 4 Cancellation + 12h rule | Done |
| 5 Manager approve + sessions CRUD | Done |
| 6 Coach participants + add | Done |
| 7 Waitlist + notify | Done (needs Expo push + webhook) |
| 8 Thursday cron | Done (needs Supabase cron schedule) |
| 9 Testing / polish | Ongoing |
