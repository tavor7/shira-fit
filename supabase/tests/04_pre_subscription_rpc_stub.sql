-- Minimal stand-in for the REAL pre-subscription-era signatures of the five RPCs touched by the
-- Sep 24-25 incident. The other stub files (00-03) never defined these -- the subscriptions
-- migrations (20260924110000 onward) were the first thing in this stand-in schema to create them,
-- at their NEW (4th-parameter-added) signatures via `create or replace function`, which in
-- Postgres creates a second overload rather than replacing a signature that doesn't match
-- (different parameter list = different function identity). Without this file, the overload
-- collision the incident was actually about can never occur in this test harness at all, making
-- 122_rpc_overload_structural_check.sql pass trivially regardless of whether
-- 20260925120112_drop_pre_subscription_rpc_overloads.sql does anything.
--
-- These bodies are throwaway placeholders (never asserted against) -- only their SIGNATURES matter
-- for reproducing the exact overload shape production had before the incident.
create or replace function public.register_for_session(p_session_id uuid)
returns json language sql as $$ select json_build_object('ok', true); $$;

create or replace function public.coach_add_athlete(p_session_id uuid, p_user_id uuid, p_allow_over_capacity boolean)
returns json language sql as $$ select json_build_object('ok', true); $$;

create or replace function public.add_manual_participant_to_session(p_session_id uuid, p_manual_participant_id uuid, p_allow_over_capacity boolean)
returns json language sql as $$ select json_build_object('ok', true); $$;

create or replace function public.manager_revert_activity_event(p_event_id uuid)
returns json language sql as $$ select json_build_object('ok', true); $$;

create or replace function public.staff_move_session_participant(
  p_from_session_id uuid, p_to_session_id uuid, p_user_id uuid, p_manual_participant_id uuid,
  p_allow_over_capacity boolean, p_decrease_source_max boolean, p_increase_dest_max boolean
)
returns json language sql as $$ select json_build_object('ok', true); $$;
