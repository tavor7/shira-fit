-- Performance Phase 2: one request for every roster row's billing price instead of one request per row.
--
-- Session Detail (ParticipantAttendanceList) called session_billing_price_ils once per participant, concurrently, on
-- every roster load - and the roster reloads after every attendance / payment change. With 12 participants that is
-- 12 requests per load (production 2026-10-31: ~63 per day from browsers, each a full edge round trip).
--
-- Semantics: none change. The batch calls the existing, authoritative session_billing_price_ils(session, user, manual)
-- once per requested id, so every value is exactly what the per-row call returns today. Nothing else is read.
-- Security: SECURITY INVOKER and adds no data access: it can only return values the caller can already obtain by calling
-- session_billing_price_ils directly (which is SECURITY DEFINER and executable by `authenticated`, unchanged here).
-- Additive: no existing object is modified, so older app versions are unaffected; the new app falls back to per-row
-- calls when this function is missing or fails, so deploy order does not matter.
-- Rollback: drop function public.session_billing_prices_ils(uuid, uuid[], uuid[]);

create or replace function public.session_billing_prices_ils(
  p_session_id uuid,
  p_user_ids uuid[],
  p_manual_participant_ids uuid[]
)
returns table (user_id uuid, manual_participant_id uuid, price_ils numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select u.id, null::uuid, public.session_billing_price_ils(p_session_id, u.id, null)
  from (select distinct x as id from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x where x is not null) u
  union all
  select null::uuid, m.id, public.session_billing_price_ils(p_session_id, null, m.id)
  from (select distinct x as id from unnest(coalesce(p_manual_participant_ids, '{}'::uuid[])) as x where x is not null) m;
$$;

comment on function public.session_billing_prices_ils(uuid, uuid[], uuid[]) is
  'Batch of session_billing_price_ils for one session: one row per requested athlete / manual participant id.';

revoke all on function public.session_billing_prices_ils(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.session_billing_prices_ils(uuid, uuid[], uuid[]) to authenticated;
