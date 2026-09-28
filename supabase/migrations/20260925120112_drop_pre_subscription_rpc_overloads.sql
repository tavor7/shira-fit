-- Sep 24-25 incident fix, now incorporated into the repository's migration history.
--
-- The subscriptions migrations (20260924110000 .. 20260924150000) added a trailing
-- `p_accept_extra_subscription_charge boolean default false` parameter to several RPCs via
-- CREATE OR REPLACE with a new signature, which creates a second overload instead of
-- replacing the old one. Because the new parameter has a default, every existing call
-- (app and internal PL/pgSQL) matches both overloads and PostgREST/Postgres fail with
-- "Could not choose the best candidate function", blocking all registrations.
--
-- The new overloads contain the full old bodies plus the subscription gate, so the old
-- signatures are dropped and all callers resolve to the subscription-aware versions.
--
-- This exact fix was already applied directly to the production database (out-of-band,
-- recorded there as migration version 20260925120112) to restore service during the
-- incident. This file gives the repository a migration with that same version, so
-- `supabase migration list` reports local and remote as aligned instead of drifted --
-- `supabase db push` will treat this version as already applied and skip re-running it.
-- All statements are idempotent (`drop function if exists`) regardless.

drop function if exists public.coach_add_athlete(uuid, uuid, boolean);
drop function if exists public.add_manual_participant_to_session(uuid, uuid, boolean);
drop function if exists public.register_for_session(uuid);
drop function if exists public.manager_revert_activity_event(uuid);
drop function if exists public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean);

notify pgrst, 'reload schema';
