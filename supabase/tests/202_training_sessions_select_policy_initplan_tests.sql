-- Tests for 20261101091000_training_sessions_select_policy_initplan.sql (local Supabase stack with data; everything runs in
-- one transaction that is rolled back, so the database is unchanged afterwards).
--   V1  for EVERY profile (athletes approved / pending / disabled, coaches, managers, super users) and for anon-like
--       callers with no profile, the rows of training_sessions visible under the migrated policy are byte-identical to
--       the rows visible under the original policy
--   V2  the same for the athlete calendar's own-registrations join (session_registrations -> training_sessions)
--   P1  the migrated policy evaluates auth.uid() once (an InitPlan), the original once per row
-- Usage: docker exec -i <db> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/202_training_sessions_select_policy_initplan_tests.sql

begin;

create temp table t202_users as
  select p.user_id::text as uid, p.role::text as role from public.profiles p
  union all select gen_random_uuid()::text, 'no_profile';
create temp table t202_fp (variant text, uid text, sessions text, joined text);
grant all on t202_fp, t202_users to authenticated;

create or replace function pg_temp.t202_fingerprint(p_variant text) returns void language plpgsql as $$
declare
  u record;
  v_s text;
  v_j text;
begin
  for u in select * from t202_users loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) into v_s from public.training_sessions x;
    select md5(coalesce(string_agg(r.id::text || ':' || coalesce(s.id::text, '-'), '|' order by r.id), '')) into v_j
      from public.session_registrations r left join public.training_sessions s on s.id = r.session_id
      where r.user_id::text = u.uid and r.status = 'active';
    execute 'reset role';
    insert into t202_fp values (p_variant, u.uid, v_s, v_j);
  end loop;
end $$;

-- Original expression (as before the migration), then the migrated one, in the same transaction.
alter policy sessions_select on public.training_sessions using (
  is_coach_or_manager(auth.uid())
  or (exists (select 1 from session_registrations r where r.session_id = training_sessions.id and r.user_id = auth.uid() and r.status = 'active'::registration_status))
  or (coalesce(is_hidden, false) = false
      and (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'athlete'::user_role and p.approval_status = 'approved'::approval_status and p.disabled_at is null))
      and session_date <= athlete_browse_week_end()));
select pg_temp.t202_fingerprint('original');
do $$ begin
  if md5((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'sessions_select')) <> '1daac36be3c1bbadd3ff3ced6ce66992' then
    raise exception 'setup FAILED: original expression not reproduced';
  end if;
end $$;
-- The migrated expression: the original with exactly its auth.uid() calls wrapped, which must deparse to the migration's
-- post-check fingerprint (so this test checks the policy that migration installs).
do $$ begin
  execute format('alter policy sessions_select on public.training_sessions using (%s)',
    replace((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'sessions_select'), 'auth.uid()', '(select auth.uid())'));
  if md5((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'sessions_select')) <> '864bf82445b915720df1835c657ae35a' then
    raise exception 'setup FAILED: migrated expression differs from 20261101091000''s post-check';
  end if;
end $$;
select pg_temp.t202_fingerprint('migrated');

do $$
declare
  v_users int;
  v_roles text;
  v_bad_s int;
  v_bad_j int;
begin
  select count(*), string_agg(distinct role, ',') into v_users, v_roles from t202_users;
  if v_users < 20 or v_roles not like '%athlete%' or v_roles not like '%coach%' or v_roles not like '%manager%' then
    raise exception 'V1 FAILED: need a seeded database with athletes, coaches and managers (% users: %)', v_users, v_roles;
  end if;
  select count(*) filter (where o.sessions <> m.sessions), count(*) filter (where o.joined <> m.joined) into v_bad_s, v_bad_j
  from t202_fp o join t202_fp m on m.uid = o.uid and m.variant = 'migrated' where o.variant = 'original';
  if v_bad_s <> 0 then raise exception 'V1 FAILED: % users see different sessions', v_bad_s; end if;
  raise notice 'V1 PASSED: % callers (%) see identical training_sessions rows', v_users, v_roles;
  if v_bad_j <> 0 then raise exception 'V2 FAILED: % users see a different own-registrations join', v_bad_j; end if;
  raise notice 'V2 PASSED: own-registrations join identical for every caller';
end $$;

do $$
declare
  v_plan text := '';
  r record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select uid from t202_users where role = 'athlete' limit 1), 'role', 'authenticated')::text, true);
  set local role authenticated;
  for r in execute 'explain select * from public.training_sessions' loop v_plan := v_plan || r."QUERY PLAN" || E'\n'; end loop;
  reset role;
  if v_plan not like '%InitPlan%' then raise exception 'P1 FAILED: no InitPlan in %', v_plan; end if;
  raise notice 'P1 PASSED: auth.uid() evaluated once (InitPlan)';
end $$;

rollback;
