-- Tests for 20261103090000_session_registrations_select_policy_initplan.sql (local Supabase stack with seeded data).
-- Everything runs in ONE transaction that is rolled back: fixtures, both policy expressions and all comparisons.
--   F   fixtures: pending, rejected and disabled athletes, a disabled coach; hidden registrations for every audience
--       combination (athlete / coach / manager / all) and an un-hidden one
--   V1  for EVERY profile, a no-profile caller and anon, the visible session_registrations rows are byte-identical under
--       the original and the new expression, for five query shapes (all; one session with hidden rows; own active;
--       upcoming sessions; the athlete calendar on training_sessions, whose policy reads registrations)
--   V2  the fixtures matter: hiding changes what coaches / managers / athletes see compared with the super user
--   P1  the new expression evaluates the role checks once (InitPlan)
-- Usage: docker exec -i <db> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/204_session_registrations_select_policy_initplan_tests.sql

begin;

-- F: fixtures --------------------------------------------------------------------------------------------------------
do $f$
declare
  v_super uuid := (select user_id from public.profiles where is_super_user limit 1);
  v_ath uuid[] := array(select user_id from public.profiles where role = 'athlete' and approval_status = 'approved' and disabled_at is null order by user_id limit 4);
  r record;
  i int := 0;
begin
  if v_super is null or array_length(v_ath, 1) < 4 then raise exception 'F FAILED: seeded database needed'; end if;
  update public.profiles set approval_status = 'pending' where user_id = v_ath[1];
  update public.profiles set approval_status = 'rejected' where user_id = v_ath[2];
  update public.profiles set disabled_at = now() where user_id = v_ath[3];
  update public.profiles set disabled_at = now() where user_id = (select user_id from public.profiles where role = 'coach' order by user_id limit 1);
  -- hidden rows: one registration per combination, distinct sessions, plus an un-hidden one
  for r in
    select distinct on (rg.session_id) rg.session_id, rg.user_id from public.session_registrations rg
    where rg.status = 'active' and not exists (select 1 from public.super_user_hidden_registrations h where h.session_id = rg.session_id and h.user_id = rg.user_id)
    order by rg.session_id, rg.user_id limit 5
  loop
    i := i + 1;
    insert into public.super_user_hidden_registrations (session_id, user_id, hidden_by, hide_from_athlete, hide_from_coach, hide_from_manager, unhidden_at)
    values (r.session_id, r.user_id, v_super,
            i in (1, 4, 5), i in (2, 4, 5), i in (3, 4, 5),
            case when i = 5 then now() end);
  end loop;
  if i < 5 then raise exception 'F FAILED: not enough registrations for hidden fixtures'; end if;
end
$f$;

create temp table t204_users as
  select p.user_id::text uid,
         p.role::text || case when p.is_super_user then '+super' else '' end
           || case when p.approval_status <> 'approved' then '+' || p.approval_status::text else '' end
           || case when p.disabled_at is not null then '+disabled' else '' end as kind
  from public.profiles p
  union all select gen_random_uuid()::text, 'no_profile'
  union all select null, 'anon';
create temp table t204 (variant text, uid text, kind text, q text, n int, h text);
grant all on t204, t204_users to authenticated, anon;

create or replace function pg_temp.t204_fp(p_variant text) returns void language plpgsql as $$
declare
  u record; n int; h text;
  v_hidden_sid uuid := (select session_id from public.super_user_hidden_registrations where hide_from_coach and hide_from_manager and unhidden_at is null order by created_at desc limit 1);
begin
  for u in select * from t204_users loop
    if u.kind = 'anon' then
      perform set_config('request.jwt.claims', '', true);
      execute 'set local role anon';
    else
      perform set_config('request.jwt.claims', json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;
    select count(*), md5(coalesce(string_agg(id::text, ',' order by id), '')) into n, h from public.session_registrations;
    insert into t204 values (p_variant, u.uid, u.kind, 'all', n, h);
    select count(*), md5(coalesce(string_agg(id::text, ',' order by id), '')) into n, h from public.session_registrations where session_id = v_hidden_sid;
    insert into t204 values (p_variant, u.uid, u.kind, 'hidden_session', n, h);
    select count(*), md5(coalesce(string_agg(id::text, ',' order by id), '')) into n, h from public.session_registrations where user_id = u.uid::uuid and status = 'active';
    insert into t204 values (p_variant, u.uid, u.kind, 'own', n, h);
    select count(*), md5(coalesce(string_agg(id::text, ',' order by id), '')) into n, h from public.session_registrations
      where status = 'active' and session_id in (select id from public.training_sessions where session_date between current_date - 7 and current_date + 14);
    insert into t204 values (p_variant, u.uid, u.kind, 'upcoming', n, h);
    select count(*), md5(coalesce(string_agg(id::text, ',' order by id), '')) into n, h from public.training_sessions
      where not is_hidden and session_date <= public.athlete_browse_week_end();
    insert into t204 values (p_variant, u.uid, u.kind, 'calendar', n, h);
    execute 'reset role';
  end loop;
end $$;

-- Original expression (whatever is deployed locally), then the migration's expression.
alter policy reg_select on public.session_registrations using (
  is_super_user(auth.uid())
  or ((user_id = auth.uid()) and (not is_registration_hidden(session_id, user_id)))
  or (is_coach(auth.uid()) and (not is_registration_hidden_from_coach(session_id, user_id)))
  or (is_manager(auth.uid()) and (not is_registration_hidden_from_manager(session_id, user_id))));
do $$ begin
  if md5((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'reg_select')) <> '79f246da6074eba07f62b57db6c18a43' then
    raise exception 'setup FAILED: original expression not reproduced';
  end if;
end $$;
select pg_temp.t204_fp('original');

alter policy reg_select on public.session_registrations using (
  (select public.is_super_user((select auth.uid())))
  or (user_id = (select auth.uid()) and not public.is_registration_hidden(session_id, user_id))
  or ((select public.is_coach((select auth.uid()))) and not public.is_registration_hidden_from_coach(session_id, user_id))
  or ((select public.is_manager((select auth.uid()))) and not public.is_registration_hidden_from_manager(session_id, user_id)));
do $$ begin
  if md5((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'reg_select')) <> '1599907cf7cf54de116b9a33341339fb' then
    raise exception 'setup FAILED: new expression differs from 20261103090000''s post-check';
  end if;
end $$;
select pg_temp.t204_fp('new');

select o.kind, o.q, count(*) callers, sum(o.n) rows_seen, bool_and(o.h = n.h and o.n = n.n) identical
from t204 o join t204 n on n.uid is not distinct from o.uid and n.kind = o.kind and n.q = o.q and n.variant = 'new'
where o.variant = 'original' group by 1, 2 order by 1, 2;

do $$
declare v_bad int; v_kinds text; v_super int; v_coach int; v_mgr int; v_hidden_ath int;
begin
  select count(*) filter (where not (o.h = n.h and o.n = n.n)), string_agg(distinct o.kind, ',')
    into v_bad, v_kinds
  from t204 o join t204 n on n.uid is not distinct from o.uid and n.kind = o.kind and n.q = o.q and n.variant = 'new'
  where o.variant = 'original';
  if v_bad <> 0 then raise exception 'V1 FAILED: % caller / query pairs differ', v_bad; end if;
  if v_kinds not like '%athlete+pending%' or v_kinds not like '%athlete+rejected%' or v_kinds not like '%athlete+disabled%'
     or v_kinds not like '%coach+disabled%' or v_kinds not like '%manager+super%' or v_kinds not like '%no_profile%' or v_kinds not like '%anon%' then
    raise exception 'V1 FAILED: caller kinds missing (%)', v_kinds;
  end if;
  raise notice 'V1 PASSED: identical visibility for every caller kind (%)', v_kinds;
  select max(n) filter (where kind = 'manager+super'), max(n) filter (where kind = 'coach'), max(n) filter (where kind = 'manager')
    into v_super, v_coach, v_mgr from t204 where variant = 'new' and q = 'all';
  if not (v_coach < v_super and v_mgr < v_super) then
    raise exception 'V2 FAILED: hidden fixtures do not change coach / manager visibility (super %, coach %, manager %)', v_super, v_coach, v_mgr;
  end if;
  raise notice 'V2 PASSED: hiding applies (super user %, coach %, manager % rows)', v_super, v_coach, v_mgr;
end $$;

do $$
declare v_plan text := ''; r record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select uid from t204_users where kind = 'coach' limit 1), 'role', 'authenticated')::text, true);
  set local role authenticated;
  for r in execute 'explain select * from public.session_registrations' loop v_plan := v_plan || r."QUERY PLAN" || E'\n'; end loop;
  reset role;
  if v_plan not like '%InitPlan%' then raise exception 'P1 FAILED: %', v_plan; end if;
  raise notice 'P1 PASSED: role checks evaluated once (InitPlan)';
end $$;

rollback;
