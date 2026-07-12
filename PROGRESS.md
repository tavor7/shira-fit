# Shira Fit — Implementation Progress

## Accounts (see README)

- [ ] **Required now:** Supabase project (DB, Auth, Edge Functions, Storage, Cron)
- [ ] **Can wait:** Expo EAS (production builds), Apple/Google push certs (dev works with Expo Go), Resend, WhatsApp Business API

## Checklist

- [x] PROGRESS.md + implementation plan
- [x] Supabase SQL schema + RLS + RPCs (166 migrations)
- [x] Edge Functions: weekly registration open, waitlist notify, notification dispatch, PDF gen, email, staff email
- [x] Expo mobile: auth, athlete, coach, manager flows
- [x] Manager web PWA (Expo web export — same codebase as mobile)
- [x] Finance, pricing, coach payouts, family accounts
- [x] Israeli digital receipts (PDF, VAT, consent, go-live gates)
- [x] WhatsApp notification rollout (off / testing / live)
- [x] Activity log with revert, manager direct messages, birthday auto-messages
- [x] README + PROJECT.md + .env.example

## Stop / external setup (you must do)

1. **Supabase project** + run migrations (`supabase db push`) + promote first user to **manager** (see README).  
2. **Edge Function secrets:** `CRON_SECRET` + deploy all functions. Optional: `RESEND_API_KEY`, `WHATSAPP_*`.  
3. **Cron:** Poll `open-weekly-registrations` on a schedule with `Authorization: Bearer CRON_SECRET`.  
4. **Waitlist push:** Vault secrets for pg_net trigger → `notify-waitlist` (see README).  
5. **Expo push token:** Stored in `profiles.expo_push_token` when notification prefs are on.

## Assumptions (not in original spec)

1. **Login identifier:** Supabase Auth uses email; **username** is stored on `profiles` for display. Signup collects email + password + profile fields.
2. **Session "day":** Derived from `session_date` (PostgreSQL `date`); no separate day column.
3. **Coach assignment:** `training_sessions.coach_id` → `profiles.user_id` where `role = coach` (or manager acting as coach).
4. **Late cancel:** 24-hour rule (not 12-hour).
5. **Manager UI:** Expo web PWA, not a separate Vite admin app.

## Phases

| Phase | Status |
|-------|--------|
| 1 Setup | Done |
| 2 Auth + profiles + pending | Done |
| 3 Athlete sessions + register | Done |
| 4 Cancellation + 24h rule | Done |
| 5 Manager approve + sessions CRUD | Done |
| 6 Coach participants + add | Done |
| 7 Waitlist + notify | Done |
| 8 Weekly registration open (cron) | Done |
| 9 Finance + pricing + coach payouts | Done |
| 10 Digital receipts + PDF + email | Done |
| 11 Consent management + go-live gates | Done |
| 12 WhatsApp notifications | Done |
| 13 Families, activity log, direct messages | Done |
| 14 Testing / polish | Ongoing |
