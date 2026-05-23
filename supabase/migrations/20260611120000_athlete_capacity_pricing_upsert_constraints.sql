-- Supabase upsert (ON CONFLICT) requires non-partial UNIQUE constraints.
-- Partial unique indexes are correct for integrity but PostgREST cannot target them.

drop index if exists public.athlete_session_capacity_pricing_user_uidx;
drop index if exists public.athlete_session_capacity_pricing_manual_uidx;

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_user_uniq;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_user_uniq
  unique (user_id, max_participants);

alter table public.athlete_session_capacity_pricing
  drop constraint if exists athlete_session_capacity_pricing_manual_uniq;

alter table public.athlete_session_capacity_pricing
  add constraint athlete_session_capacity_pricing_manual_uniq
  unique (manual_participant_id, max_participants);

comment on constraint athlete_session_capacity_pricing_user_uniq on public.athlete_session_capacity_pricing is
  'One override per app athlete per capacity tier (user_id set, manual_participant_id null).';

comment on constraint athlete_session_capacity_pricing_manual_uniq on public.athlete_session_capacity_pricing is
  'One override per Quick Add participant per capacity tier (manual_participant_id set, user_id null).';
