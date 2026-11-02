-- Tests for 20261102120000_weekly_stats_price_once_per_call.sql (local Supabase stack with seeded data; run AFTER the
-- migration). Part 1 runs in one transaction that is rolled back; part 2 is a read-only transaction. Nothing persists.
--   E1  full JSON of manager_weekly_stats (memo) is byte-identical to the original engine (recreated in the transaction
--       as *_orig clones by reversing the migration's edits) for every week, every month and global, as a manager and
--       as a super user
--   E2  the same for direct calls of manager_weekly_stats_core (it is directly executable by API roles)
--   E3  athlete / no-profile / anonymous callers get the same refusal as before
--   E4  an empty future period is identical
--   E5  freshness: a roster price changed after a call in the same transaction is reflected by the next call, exactly as
--       the original engine reflects it
--   E6  the memo flag is off after the wrapper returns
--   P1  price-function calls per call, original vs memo (pg_stat_get_xact_function_calls) and timing (printed)
--   R1  read-only transaction: the memo is skipped and the output is identical to the read-write output
-- Usage: docker exec -i <db> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/203_weekly_stats_price_memo_equivalence_tests.sql

begin;

-- Original engine, recreated from the deployed (memo) definitions by reversing exactly the migration's edits.
do $clone$
declare
  src text;
begin
  if to_regprocedure('public._mws_price(uuid,uuid,uuid)') is null then
    raise exception 'setup FAILED: run 20261102120000 first';
  end if;
  foreach src in array array[
    pg_get_functiondef('public.manager_weekly_stats_core(date,text)'::regprocedure),
    pg_get_functiondef('public._period_merged_athlete_finance(date,date)'::regprocedure),
    pg_get_functiondef('public._manager_weekly_stats_families_json(date,date)'::regprocedure),
    pg_get_functiondef('public.manager_weekly_stats(date,text)'::regprocedure)
  ] loop
    src := replace(src, 'public.manager_weekly_stats_core(', 'public.manager_weekly_stats_core_orig(');
    src := replace(src, 'public._period_merged_athlete_finance(', 'public._period_merged_athlete_finance_orig(');
    src := replace(src, 'public._manager_weekly_stats_families_json(', 'public._manager_weekly_stats_families_json_orig(');
    src := replace(src, 'FUNCTION public.manager_weekly_stats(', 'FUNCTION public.manager_weekly_stats_orig(');
    src := replace(src, 'public._mws_price(s.id, reg.user_id, null)', 'public.session_billing_price_ils(s.id, reg.user_id)');
    src := replace(src, 'public._mws_price(s.id, c.user_id, null)', 'public.session_billing_price_ils(s.id, c.user_id)');
    src := replace(src, 'public._mws_price(s.id, null, m.manual_participant_id)', 'public.session_billing_price_ils(s.id, null, m.manual_participant_id)');
    src := replace(src, E'\n  -- Performance Phase 3: price every slot of the period once for this call (see _mws_prepare_price_memo).\n  perform public._mws_prepare_price_memo(v_start, v_end);\n', '');
    src := replace(src, E'  -- The families block above was the last reader of this call''s price memo.\n  perform set_config(''shirafit.mws_price_memo'', ''off'', true);\n\n', '');
    if src like '%_mws_%' then raise exception 'setup FAILED: clone still references the memo'; end if;
    execute src;
  end loop;
  -- The reversed clones must be byte-identical to the reviewed production bodies.
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.manager_weekly_stats_core_orig(date,text)')) <> 'ee8089219086630cb83eb1be626c326e'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._period_merged_athlete_finance_orig(date,date)')) <> 'd43c934013f1d8b4136844c9d0b1a338' then
    raise exception 'setup FAILED: reversed clones differ from the reviewed original bodies';
  end if;
end
$clone$;

create temp table t203 (who text, fn text, mode text, anchor date, same boolean, ms_orig numeric, ms_memo numeric,
  calls_orig bigint, calls_memo bigint, bytes int);
create temp table t203_users as
  select 'manager'::text who, (select p.user_id::text from public.profiles p where p.role = 'manager' and not coalesce(p.is_super_user, false) and p.disabled_at is null limit 1) uid
  union all select 'super_user', (select p.user_id::text from public.profiles p where p.is_super_user limit 1)
  union all select 'athlete', (select p.user_id::text from public.profiles p where p.role = 'athlete' limit 1)
  union all select 'no_profile', gen_random_uuid()::text;
grant all on t203, t203_users to authenticated, anon;

create or replace function pg_temp.t203_run(p_who text, p_fn text, p_mode text, p_anchor date) returns void language plpgsql as $$
declare
  t0 timestamptz; o text; n text; d_o numeric; d_n numeric; c0 bigint; c_o bigint; c_n bigint;
  price_fn oid := to_regprocedure('public.session_billing_price_ils(uuid,uuid,uuid)');
begin
  c0 := coalesce(pg_stat_get_xact_function_calls(price_fn), 0);
  t0 := clock_timestamp();
  if p_fn = 'wrapper' then o := public.manager_weekly_stats_orig(p_anchor, p_mode)::text; else o := public.manager_weekly_stats_core_orig(p_anchor, p_mode)::text; end if;
  d_o := extract(epoch from clock_timestamp() - t0) * 1000;
  c_o := coalesce(pg_stat_get_xact_function_calls(price_fn), 0) - c0;
  c0 := coalesce(pg_stat_get_xact_function_calls(price_fn), 0);
  t0 := clock_timestamp();
  if p_fn = 'wrapper' then n := public.manager_weekly_stats(p_anchor, p_mode)::text; else n := public.manager_weekly_stats_core(p_anchor, p_mode)::text; end if;
  d_n := extract(epoch from clock_timestamp() - t0) * 1000;
  c_n := coalesce(pg_stat_get_xact_function_calls(price_fn), 0) - c0;
  insert into t203 values (p_who, p_fn, p_mode, p_anchor, o = n, round(d_o, 1), round(d_n, 1), c_o, c_n, length(o));
end $$;

create or replace function pg_temp.t203_all(p_who text) returns void language plpgsql as $$
declare a date; m text;
begin
  for m, a in
    select 'week', d::date from generate_series((select min(session_date) from public.training_sessions), (select max(session_date) from public.training_sessions), interval '7 days') d
    union all select 'month', d::date from generate_series(date_trunc('month', (select min(session_date) from public.training_sessions)), (select max(session_date) from public.training_sessions), interval '1 month') d
    union all select 'global', current_date
    union all select 'week', (select max(session_date) from public.training_sessions) + 400   -- E4 empty future period
  loop
    perform pg_temp.t203_run(p_who, 'wrapper', m, a);
  end loop;
  -- E2: direct core calls, a sample of periods
  perform pg_temp.t203_run(p_who, 'core', 'week', current_date);
  perform pg_temp.t203_run(p_who, 'core', 'month', current_date);
  perform pg_temp.t203_run(p_who, 'core', 'global', current_date);
end $$;

set local track_functions = 'all';
do $run$
declare u record;
begin
  for u in select * from t203_users loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    if u.who in ('manager', 'super_user') then
      perform pg_temp.t203_all(u.who);
    else
      perform pg_temp.t203_run(u.who, 'wrapper', 'week', current_date);   -- E3
      perform pg_temp.t203_run(u.who, 'core', 'week', current_date);
    end if;
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  perform pg_temp.t203_run('anon', 'wrapper', 'week', current_date);       -- E3
  execute 'reset role';
end
$run$;

select who, fn, mode, count(*) periods, bool_and(same) identical, round(avg(ms_orig), 1) avg_ms_orig, round(avg(ms_memo), 1) avg_ms_memo,
       round(avg(calls_orig)) avg_price_calls_orig, round(avg(calls_memo)) avg_price_calls_memo, max(bytes) max_bytes
from t203 group by who, fn, mode order by who, fn, mode;

do $check$
declare v_bad int; v_n int; v_roles text;
begin
  select count(*) filter (where not same), count(*), string_agg(distinct who, ',') into v_bad, v_n, v_roles from t203;
  if v_n < 80 or v_roles not like '%manager%' or v_roles not like '%super_user%' then
    raise exception 'E1 FAILED: too few comparisons (%) or roles (%) - seeded database needed', v_n, v_roles;
  end if;
  if v_bad <> 0 then raise exception 'E1-E4 FAILED: % of % outputs differ', v_bad, v_n; end if;
  raise notice 'E1-E4 PASSED: % outputs byte-identical (roles: %)', v_n, v_roles;
  perform set_config('request.jwt.claims', json_build_object('sub', (select uid from t203_users where who = 'manager'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.manager_weekly_stats(current_date, 'week');
  execute 'reset role';
  if current_setting('shirafit.mws_price_memo', true) = 'on' then raise exception 'E6 FAILED: memo flag left on after the wrapper'; end if;
  raise notice 'E6 PASSED: memo flag off after the wrapper';
end
$check$;

-- E5: change a roster price after a call; the next call must reflect it exactly like the original engine.
do $fresh$
declare
  v_mgr text := (select uid from t203_users where who = 'manager');
  v_sid uuid; v_uid uuid; v_date date; before_txt text; after_memo text; after_orig text;
begin
  select r.session_id, r.user_id, s.session_date into v_sid, v_uid, v_date
  from public.session_registrations r join public.training_sessions s on s.id = r.session_id
  where r.status = 'active' and r.attended is true order by s.session_date desc limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  before_txt := public.manager_weekly_stats(v_date, 'week')::text;
  execute 'reset role';
  insert into public.session_roster_slot_prices (session_id, user_id, price_ils) values (v_sid, v_uid, 987.65)
    on conflict do nothing;
  update public.session_roster_slot_prices set price_ils = 987.65 where session_id = v_sid and user_id = v_uid;
  execute 'set local role authenticated';
  after_memo := public.manager_weekly_stats(v_date, 'week')::text;
  after_orig := public.manager_weekly_stats_orig(v_date, 'week')::text;
  execute 'reset role';
  if after_memo = before_txt then raise exception 'E5 FAILED: price change not reflected'; end if;
  if after_memo <> after_orig then raise exception 'E5 FAILED: after the change, memo and original differ'; end if;
  raise notice 'E5 PASSED: a price change between calls is reflected, identical to the original engine';
end
$fresh$;

rollback;

-- R1: read-only transaction (memo cannot be created there) gives the same output as read-write.
select p.user_id as r1_uid from public.profiles p where p.role = 'manager' and not coalesce(p.is_super_user, false) and p.disabled_at is null limit 1 \gset
begin;
select set_config('request.jwt.claims', json_build_object('sub', :'r1_uid', 'role', 'authenticated')::text, true) \gset r1_
set local role authenticated;
select md5(public.manager_weekly_stats(current_date, 'month')::text) as r1_rw \gset
commit;
begin transaction read only;
select set_config('request.jwt.claims', json_build_object('sub', :'r1_uid', 'role', 'authenticated')::text, true) \gset r1_
set local role authenticated;
select md5(public.manager_weekly_stats(current_date, 'month')::text) as r1_ro \gset
commit;
select case when :'r1_rw' = :'r1_ro' then 'R1 PASSED: read-only output identical' else 'R1 FAILED' end as r1;
-- Fails the script (division by zero under ON_ERROR_STOP) when the outputs differ.
select 1 / (case when :'r1_rw' = :'r1_ro' then 1 else 0 end) as r1_assert;
