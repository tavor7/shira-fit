# Applying date-effective pricing (`20260613120000`)

## Local (clean chain)

```bash
supabase db reset
# or: supabase migration up
```

Confirm migration `20260613120000_pricing_effective_dates.sql` applies after `20260608*`–`20260612*` with no errors (especially `coach_capacity_price_ils` exists for weekly stats).

## Production Supabase (partial state)

If you already ran `20260609120000` in the SQL editor (not in repo), apply **only** the new migration:

1. Supabase Dashboard → SQL → New query, or `supabase db push` from this repo.
2. Run `20260613120000_pricing_effective_dates.sql` (idempotent: safe if `effective_from` columns already exist).
3. Verify:
   - `session_capacity_pricing`, `athlete_session_capacity_pricing`, `coach_capacity_pricing` have `id` PK and exclusion constraints.
   - Old uniques `athlete_session_capacity_pricing_user_uniq` / `manual_uniq` are dropped.
   - `SELECT public.coach_capacity_price_ils('00000000-0000-0000-0000-000000000000'::uuid, 6, current_date);` does not error (returns 0 if no row).

## Quick checks after deploy

| Check | Expected |
|-------|----------|
| Two overlapping global rates for same cap + dates | Rejected (exclusion) |
| Non-overlapping periods (e.g. 75₪ until May 31, 80₪ from Jun 1) | Both rows; billing uses `session_date` |
| Mobile pricing screens | Insert new period; edit by row `id`; subtitle shows date range |
| Weekly overview / coach report | No missing-function errors |

Mobile app must be on a build that uses insert/update-by-`id` (not upsert on `user_id,max_participants`).
