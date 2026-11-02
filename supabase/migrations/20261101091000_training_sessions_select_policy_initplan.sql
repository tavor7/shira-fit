-- Performance Phase 2: evaluate auth.uid() once per query (not once per row) in the training_sessions SELECT policy.
--
-- Why: in sessions_select, `r.user_id = auth.uid()` inside the EXISTS over session_registrations is not treated as a
-- constant, so Postgres cannot use the registrations' user_id index: it scans every active registration and runs that
-- table's own RLS helpers on each one. Production, 2026-10-31 (EXPLAIN ANALYZE in a read-only transaction as an approved
-- athlete): 82 ms for one athlete's calendar query, 73 ms of it in that sub-plan. Wrapping the call as
-- `(select auth.uid())` makes it an init-plan evaluated once (Supabase's documented RLS performance pattern; advisor
-- lint auth_rls_initplan). Local perf stack: athlete 34.5 ms -> 3.9 ms, coach 3.9 ms -> 3.0 ms.
--
-- Semantics: identical. auth.uid() is STABLE (one value per statement), so evaluating it once gives the same value on
-- every row. The expression below is the deployed one with exactly the three `auth.uid()` occurrences replaced; nothing
-- else (command, roles, permissive, other policies) changes. Verified on the perf stack: for an athlete, a second
-- athlete, a coach, a manager and the super user, the set of visible rows of training_sessions (and of the related
-- tables) is byte-identical before and after (supabase/tests/202).
-- Precondition: aborts unless the deployed expression is byte-identical to the reviewed one (md5 1daac36b..., checked on
-- production read-only 2026-10-31). Post-check: the new expression has the expected fingerprint (as deparsed by
-- Postgres, which prints `(select auth.uid())` as `( SELECT auth.uid() AS uid)`).
-- Rollback: docs/performance/rollback/20261101091000_training_sessions_select_policy_initplan_ROLLBACK.sql (restores the
-- previous expression, with its own pre- and post-check).

do $$
declare
  v_old_md5 constant text := '1daac36be3c1bbadd3ff3ced6ce66992';
  v_new_md5 constant text := '864bf82445b915720df1835c657ae35a';
  v_cur text;
begin
  select pg_get_expr(polqual, polrelid) into v_cur
  from pg_policy where polname = 'sessions_select' and polrelid = 'public.training_sessions'::regclass and polcmd = 'r';
  if v_cur is null then
    raise exception 'precondition failed, nothing changed: policy sessions_select (SELECT) not found';
  end if;
  if md5(v_cur) = v_new_md5 then
    raise notice 'sessions_select already uses (select auth.uid()); nothing to do';
    return;
  end if;
  if md5(v_cur) <> v_old_md5 then
    raise exception 'precondition failed, nothing changed: sessions_select drifted (md5 %)', md5(v_cur);
  end if;

  alter policy sessions_select on public.training_sessions using (
    is_coach_or_manager((select auth.uid()))
    or (exists (
      select 1 from session_registrations r
      where r.session_id = training_sessions.id and r.user_id = (select auth.uid()) and r.status = 'active'::registration_status
    ))
    or (
      coalesce(is_hidden, false) = false
      and (exists (
        select 1 from profiles p
        where p.user_id = (select auth.uid()) and p.role = 'athlete'::user_role
          and p.approval_status = 'approved'::approval_status and p.disabled_at is null
      ))
      and session_date <= athlete_browse_week_end()
    )
  );

  select pg_get_expr(polqual, polrelid) into v_cur
  from pg_policy where polname = 'sessions_select' and polrelid = 'public.training_sessions'::regclass;
  if md5(v_cur) <> v_new_md5 then
    raise exception 'post-check failed (md5 %), rolled back', md5(v_cur);
  end if;
end
$$;
