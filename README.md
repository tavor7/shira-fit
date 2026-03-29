# Shira Fit — Fitness studio training app

React Native (Expo) + Supabase + TypeScript. See **`app description.txt`** (source of truth) and **`PROGRESS.md`**.

## Accounts

### Required now (minimum)

| Account | Why |
|--------|-----|
| **Supabase** | Database, Auth, Row Level Security, Edge Functions, Cron |

### Can wait

| Account | Why |
|--------|-----|
| **Expo** (EAS) | Production builds & OTA |
| **Apple Developer / Google Play** | Store releases |
| **Expo push** | Works in dev with Expo Go; production needs EAS + credentials |

---

## Supabase setup (exact steps)

1. **Create project** at [supabase.com](https://supabase.com) → New project → note **Project URL** and **anon key** (Settings → API).

2. **Run SQL**  
   Open SQL Editor → paste contents of `supabase/migrations/20250314000000_initial.sql` → Run.

3. **Auth**  
   Authentication → Providers → Email enabled (default).  
   **Password reset:** Authentication → URL Configuration → add every redirect you use, e.g.  
   `http://localhost:8081/--/(auth)/reset-password`  
   `http://localhost:19006/--/(auth)/reset-password` (if port differs)  
   Production: `https://yourdomain.com/--/(auth)/reset-password`  
   Same URLs under **Redirect URLs**. Save.

4. **Run migration updates (signup: DOB + gender)**  
   After the initial migration, run `supabase/migrations/20250315000000_dob_gender_reset.sql` in SQL Editor once.  
   Optionally disable public signups later and invite only.

5. **First manager**  
   - Sign up once in the app (athlete).  
   - Dashboard → Authentication → copy user UUID.  
   - SQL:
     ```sql
     update public.profiles
     set role = 'manager', approval_status = 'approved'
     where user_id = 'PASTE_UUID';
     ```
   - Create **coach**: second signup, then:
     ```sql
     update public.profiles set role = 'coach', approval_status = 'approved' where user_id = 'COACH_UUID';
     ```
   - **Training sessions** need a valid `coach_id` (that coach’s `user_id`).

6. **Edge Functions**  
   ```bash
   supabase login
   supabase link --project-ref YOUR_REF
   supabase secrets set CRON_SECRET=your-long-random-string
   supabase functions deploy open-weekly-registrations
   supabase functions deploy notify-waitlist
   ```

7. **Thursday 08:00 cron**  
   Dashboard → Edge Functions → Schedules (or use external cron):  
   `POST https://YOUR_REF.supabase.co/functions/v1/open-weekly-registrations`  
   Header: `Authorization: Bearer YOUR_CRON_SECRET`  
   Schedule: `0 8 * * 4` (Thursday 08:00 UTC — adjust timezone if needed).

7. **Waitlist push when spot opens**  
   After a cancellation, call:
   `POST .../functions/v1/notify-waitlist`  
   Body: `{"session_id":"<uuid>"}`  
   Same `Authorization: Bearer CRON_SECRET`.  
   Optional: Database Webhook on `session_registrations` UPDATE → invoke this function (document your URL + secret).

9. **Keys in the project**  
   - Copy **URL** + **anon key** into `mobile/.env`:
     ```
     EXPO_PUBLIC_SUPABASE_URL=...
     EXPO_PUBLIC_SUPABASE_ANON_KEY=...
     ```
   - Same for `admin/.env` as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

---

## Mobile (Expo)

```bash
cd mobile
cp ../.env.example .env   # fill EXPO_PUBLIC_*
npm install
npx expo start
```

Use **email + password** (Supabase). Username is stored on `profiles`.

### Open on a real phone (Expo Go — no App Store yet)

1. Install **[Expo Go](https://expo.dev/go)** on the phone (iOS App Store or Google Play).
2. On your Mac, from `mobile/`, run `npm run start` (or `npm run start:lan` if the QR uses the wrong interface).
3. **Same Wi‑Fi as the computer:** open Expo Go → scan the QR from the terminal or browser Dev Tools page.
4. **Different network / QR won’t connect:** run `npm run start:tunnel` and scan again (slower, needs internet; first run may prompt to install `@expo/ngrok`).

The JavaScript bundle still comes from your machine, so the computer must stay on while others test.

**Expo Go not loading?** Use the latest **Expo Go** from the store (must match SDK 55). Start with `npm run start` or `npx expo start` — not only `expo start --web` — then scan the QR. Same Wi‑Fi or `npm run start:tunnel`. If the bundler shows a red error, fix that first (the app will not open in Expo Go until the bundle succeeds).

### Hosted web (works when your Mac is off)

The mobile app also runs in the **phone browser** from a static host. Build embeds `EXPO_PUBLIC_*` from the environment at build time.

```bash
cd mobile
# ensure .env has EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
npm run build:web
```

Output is **`mobile/dist/`**. You can upload `dist/` manually, or let Vercel build from Git (recommended).

#### Vercel (step by step)

1. **Push the repo** to GitHub, GitLab, or Bitbucket (Vercel needs a remote to import).
2. Go to [vercel.com](https://vercel.com) → sign in → **Add New…** → **Project** → **Import** your repository.
3. **Root Directory:** set to **`mobile`** (the folder that contains `package.json` and `vercel.json`). If Vercel does not show this on the first screen, expand **Root Directory** / **Edit** and choose `mobile`.
4. **Build settings:** leave as detected or use:
   - **Build Command:** `npm run build:web`
   - **Output Directory:** `dist`  
   The repo’s `mobile/vercel.json` already sets these; Vercel usually picks them up.
5. **Environment Variables** (required — the app is built with these baked in):
   - `EXPO_PUBLIC_SUPABASE_URL` — same value as in local `mobile/.env`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` — same as in local `mobile/.env`  
   Add both for **Production** (and **Preview** if you want preview deployments to work).
6. Click **Deploy**. When it finishes, open the **.vercel.app** URL and sign in to test.

**Supabase:** Dashboard → **Authentication** → **URL Configuration**  
Set **Site URL** to your Vercel URL (e.g. `https://shira-fit-xxx.vercel.app`). Under **Redirect URLs**, add at least:

- `https://YOUR_VERCEL_HOST/--/(auth)/reset-password`  
  (and the same for any custom domain you attach later)

**Optional:** **Project** → **Settings** → **Domains** to add your own domain.

**CLI (alternative):** from `mobile/`, run `npx vercel` and follow prompts; set the same env vars in the dashboard under **Settings → Environment Variables** if the CLI did not add them.

- **Netlify:** root `mobile`, build command `npm run build:web`, publish `dist` (see `mobile/netlify.toml`).

On a phone: open the URL in Safari/Chrome and use **Share → Add to Home Screen** for an app-like icon. Native App Store / Play builds later use **EAS Build**; they are separate from this static web deploy.

---

## Admin web

```bash
cd admin
cp ../.env.example .env   # fill VITE_*
npm install
npm run dev
```

Sign in as **manager** or **coach**. Screens: athletes, sessions, history (extend as needed).

---

## Repo layout

```
mobile/           Expo app (expo-router)
admin/            Vite React dashboard
supabase/
  migrations/     PostgreSQL + RLS + RPCs
  functions/      open-weekly-registrations, notify-waitlist
```

---

## Assumptions (see PROGRESS.md)

- Login identifier: **email** (Supabase); **username** on profile.  
- Registration window: Edge Function opens **Sun–Sat** of the week starting the **next Sunday** from run date (aligned with “Thursday opens next week”).  
- Push: athletes should register device token into `profiles.expo_push_token` (optional hook in app).
