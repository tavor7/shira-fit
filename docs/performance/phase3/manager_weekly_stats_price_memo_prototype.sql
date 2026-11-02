-- PROPOSAL PROTOTYPE, NOT A MIGRATION (Performance Phase 3, Priority 1). Runs entirely in one transaction that is ROLLED BACK.
-- Local / scratch stacks with seeded data only; never production.
--
-- Clones manager_weekly_stats with exactly one change: every session_billing_price_ils(session, user, manual) call in the
-- engine (core, _period_merged_athlete_finance, families) is routed through _mws_price, which reads a per-call memo of
-- that same function for every slot of the period (and computes it on a miss). Then compares the full JSON output of the
-- current and memoized versions, byte for byte, for every week and month of the data plus global mode, as a manager
-- and as a super user, and times both.
--
-- Usage: docker exec -i <db> psql -U postgres -At -v mgr=<manager user id> -v sup=<super user id> -f - < this file
\set ON_ERROR_STOP 1
begin;
create temp table _mws_prices (session_id uuid, user_id uuid, manual_id uuid, price numeric);
-- Per-call memo of session_billing_price_ils(session, user, manual) for every slot of the period.
create or replace function public._mws_price(p_sid uuid, p_uid uuid, p_mid uuid) returns numeric language sql stable as $f$
  select coalesce(
    case when p_uid is not null
      then (select m.price from _mws_prices m where m.session_id = p_sid and m.user_id = p_uid)
      else (select m.price from _mws_prices m where m.session_id = p_sid and m.manual_id = p_mid) end,
    public.session_billing_price_ils(p_sid, p_uid, p_mid))
$f$;
create index on _mws_prices (session_id, user_id);
create index on _mws_prices (session_id, manual_id);
do $x$
declare src text;
begin
  -- Clone the engine with only the price calls (and its own function names) changed.
  foreach src in array array[
    pg_get_functiondef('public.manager_weekly_stats_core(date,text)'::regprocedure),
    (select pg_get_functiondef(oid) from pg_proc where proname = '_period_merged_athlete_finance'),
    pg_get_functiondef('public._manager_weekly_stats_families_json(date,date)'::regprocedure)
  ] loop
    src := replace(src, 'public.manager_weekly_stats_core(', 'public.manager_weekly_stats_core_proto(');
    src := replace(src, 'public._period_merged_athlete_finance(', 'public._period_merged_athlete_finance_proto(');
    src := replace(src, 'public._manager_weekly_stats_families_json(', 'public._manager_weekly_stats_families_json_proto(');
    src := replace(src, 'public.session_billing_price_ils(s.id, reg.user_id)', 'public._mws_price(s.id, reg.user_id, null)');
    src := replace(src, 'public.session_billing_price_ils(s.id, c.user_id)', 'public._mws_price(s.id, c.user_id, null)');
    src := replace(src, 'public.session_billing_price_ils(s.id, null, m.manual_participant_id)', 'public._mws_price(s.id, null, m.manual_participant_id)');
    if src like '%session_billing_price_ils%' then raise exception 'unreplaced price call'; end if;
    execute src;
  end loop;
end $x$;
create or replace function public.manager_weekly_stats_proto(p_anchor date, p_mode text default 'week') returns json
language plpgsql security definer set search_path to 'public' as $f$
declare v_result json; v_start date; v_end date; v_finance json; v_mode text := lower(trim(coalesce(p_mode, 'week')));
begin
  if v_mode not in ('week','month','global') then v_mode := 'week'; end if;
  select b.period_start, b.period_end into v_start, v_end from public._manager_stats_period_bounds(p_anchor, v_mode) b;
  truncate _mws_prices;
  insert into _mws_prices
    select distinct r.session_id, r.user_id, null::uuid, public.session_billing_price_ils(r.session_id, r.user_id, null)
      from public.session_registrations r join public.training_sessions s on s.id = r.session_id where s.session_date between v_start and v_end
    union
    select distinct c.session_id, c.user_id, null::uuid, public.session_billing_price_ils(c.session_id, c.user_id, null)
      from public.cancellations c join public.training_sessions s on s.id = c.session_id where s.session_date between v_start and v_end
    union
    select distinct m.session_id, null::uuid, m.manual_participant_id, public.session_billing_price_ils(m.session_id, null, m.manual_participant_id)
      from public.session_manual_participants m join public.training_sessions s on s.id = m.session_id where s.session_date between v_start and v_end;
  v_result := public.manager_weekly_stats_core_proto(p_anchor, p_mode);
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;
  v_start := (v_result->>'week_start')::date; v_end := (v_result->>'week_end')::date;
  v_finance := (coalesce(v_result->'finance', '{}'::json)::jsonb || jsonb_build_object('families',
    coalesce(public._manager_weekly_stats_families_json_proto(v_start, v_end), '[]'::json)::jsonb))::json;
  return jsonb_set(v_result::jsonb, '{finance}', v_finance::jsonb)::json;
end $f$;
grant all on _mws_prices to authenticated;
create temp table _cmp (who text, mode text, anchor date, same_text boolean, same_jsonb boolean, ms_old numeric, ms_new numeric, bytes int);
grant all on _cmp to authenticated;
create or replace function pg_temp.cmp(p_who text) returns void language plpgsql as $f$
declare a date; m text; t0 timestamptz; o json; n json; d_old numeric; d_new numeric;
begin
  for m, a in
    select 'week', d::date from generate_series((select min(session_date) from public.training_sessions), (select max(session_date) from public.training_sessions), interval '7 days') d
    union all select 'month', d::date from generate_series(date_trunc('month', (select min(session_date) from public.training_sessions)), (select max(session_date) from public.training_sessions), interval '1 month') d
    union all select 'global', current_date
  loop
    t0 := clock_timestamp(); o := public.manager_weekly_stats(a, m); d_old := extract(epoch from clock_timestamp() - t0) * 1000;
    t0 := clock_timestamp(); n := public.manager_weekly_stats_proto(a, m); d_new := extract(epoch from clock_timestamp() - t0) * 1000;
    insert into _cmp values (p_who, m, a, o::text = n::text, o::jsonb = n::jsonb, round(d_old, 1), round(d_new, 1), length(o::text));
  end loop;
end $f$;
select set_config('request.jwt.claims', json_build_object('sub', :'mgr', 'role', 'authenticated')::text, true);
set local role authenticated; select pg_temp.cmp('manager'); reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'sup', 'role', 'authenticated')::text, true);
set local role authenticated; select pg_temp.cmp('super_user'); reset role;
select who, mode, count(*) periods, bool_and(same_text) all_identical_text, bool_and(same_jsonb) all_identical_jsonb,
  round(avg(ms_old),1) avg_ms_old, round(avg(ms_new),1) avg_ms_new, max(bytes) max_bytes
from _cmp group by who, mode order by who, mode;
select who, mode, anchor from _cmp where not same_text limit 5;
rollback;
