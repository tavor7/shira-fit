-- Rollback for 20261101091000_training_sessions_select_policy_initplan.sql: restores the previous sessions_select
-- expression (auth.uid() evaluated per row). Visibility is identical either way; only the query cost differs.
-- Aborts unless the policy is exactly the one that migration installed.
do $$
declare
  v_cur text;
begin
  select pg_get_expr(polqual, polrelid) into v_cur
  from pg_policy where polname = 'sessions_select' and polrelid = 'public.training_sessions'::regclass and polcmd = 'r';
  if md5(coalesce(v_cur, '')) <> '864bf82445b915720df1835c657ae35a' then
    raise exception 'rollback precondition failed, nothing changed (md5 %)', md5(coalesce(v_cur, ''));
  end if;
  alter policy sessions_select on public.training_sessions using (
    is_coach_or_manager(auth.uid())
    or (exists (
      select 1 from session_registrations r
      where r.session_id = training_sessions.id and r.user_id = auth.uid() and r.status = 'active'::registration_status
    ))
    or (
      coalesce(is_hidden, false) = false
      and (exists (
        select 1 from profiles p
        where p.user_id = auth.uid() and p.role = 'athlete'::user_role
          and p.approval_status = 'approved'::approval_status and p.disabled_at is null
      ))
      and session_date <= athlete_browse_week_end()
    )
  );
  select pg_get_expr(polqual, polrelid) into v_cur from pg_policy where polname = 'sessions_select' and polrelid = 'public.training_sessions'::regclass;
  if md5(v_cur) <> '1daac36be3c1bbadd3ff3ced6ce66992' then
    raise exception 'rollback post-check failed (md5 %), rolled back', md5(v_cur);
  end if;
end
$$;
