-- Performance Phase 4: evaluate the role checks in the session_registrations SELECT policy once per query.
--
-- Why: reg_select calls is_super_user(auth.uid()), is_coach(auth.uid()) and is_manager(auth.uid()) - SECURITY DEFINER
-- SQL functions Postgres cannot inline - for EVERY row it filters; each is a profiles lookup with the same answer on every
-- row. Staff reads of many registrations paid ~45-70 ms of policy work (perf stack, all registrations).
-- Change: the three role checks (and auth.uid() in the own-row branch) become init-plans, evaluated once per query. The
-- per-row hidden-registration checks are unchanged. Same functions, same arguments; auth.uid() and the helpers are STABLE,
-- so the policy admits exactly the same rows. Only reg_select changes (reg_update_manager / reg_delete_manager untouched).
-- Evidence: supabase/tests/204 compares every caller's visible rows under the original and new expression (all profiles,
-- pending / rejected / disabled athletes, a disabled coach, hidden rows for every audience combination, un-hidden rows,
-- a no-profile caller and anon) on several query shapes.
-- Precondition: aborts unless the deployed reg_select expression and the six helper functions are byte-identical to the
-- reviewed ones (checked on production read-only 2026-11-02). Post-check: the new expression has the expected
-- fingerprint (as deparsed by Postgres). Re-running is a no-op.
-- Rollback: docs/performance/rollback/20261103090000_session_registrations_select_policy_initplan_ROLLBACK.sql.

do $$
declare
  v_old constant text := '79f246da6074eba07f62b57db6c18a43';
  v_new constant text := '1599907cf7cf54de116b9a33341339fb';
  v_cur text;
  v_bad text := '';
  r record;
begin
  select md5(pg_get_expr(polqual, polrelid)) into v_cur
  from pg_policy where polname = 'reg_select' and polrelid = 'public.session_registrations'::regclass and polcmd = 'r';
  if v_cur is null then
    raise exception 'precondition failed, nothing changed: reg_select (SELECT) not found';
  end if;
  if v_cur = v_new then
    raise notice 'reg_select already evaluates its role checks once per query; nothing to do';
    return;
  end if;
  if v_cur <> v_old then
    raise exception 'precondition failed, nothing changed: reg_select drifted (md5 %)', v_cur;
  end if;
  for r in select * from (values
    ('is_super_user', '78c681e7515056ea9718622bb07982af'),
    ('is_coach', '3711e6a9f97014b6afbf6f3ca68fbda8'),
    ('is_manager', 'b2ba5db6a87b648e9bde978866734363'),
    ('is_registration_hidden', 'e65e36b9d37f928b7c1969d1618224d9'),
    ('is_registration_hidden_from_coach', '176ca809a8db328bb1623c7619a0c15b'),
    ('is_registration_hidden_from_manager', '90539841c109d7cafa79c023b64babec')
  ) as t(fn, h) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fn) is distinct from r.h then
      v_bad := v_bad || ' ' || r.fn;
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'precondition failed, nothing changed: helper drifted:%', v_bad;
  end if;

  alter policy reg_select on public.session_registrations using (
    (select public.is_super_user((select auth.uid())))
      or (user_id = (select auth.uid()) and not public.is_registration_hidden(session_id, user_id))
      or ((select public.is_coach((select auth.uid()))) and not public.is_registration_hidden_from_coach(session_id, user_id))
      or ((select public.is_manager((select auth.uid()))) and not public.is_registration_hidden_from_manager(session_id, user_id))
  );

  select md5(pg_get_expr(polqual, polrelid)) into v_cur
  from pg_policy where polname = 'reg_select' and polrelid = 'public.session_registrations'::regclass;
  if v_cur <> v_new then
    raise exception 'post-check failed (md5 %), rolled back', v_cur;
  end if;
end
$$;
