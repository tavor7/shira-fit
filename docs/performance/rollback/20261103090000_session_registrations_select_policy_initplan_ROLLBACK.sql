-- Rollback for 20261103090000_session_registrations_select_policy_initplan.sql: restores the previous reg_select
-- expression (role checks evaluated per row). Visibility is identical either way; only the query cost differs.
-- Aborts unless the policy is exactly the one that migration installed.
do $$
declare
  v_cur text;
begin
  select md5(pg_get_expr(polqual, polrelid)) into v_cur
  from pg_policy where polname = 'reg_select' and polrelid = 'public.session_registrations'::regclass and polcmd = 'r';
  if v_cur is distinct from '1599907cf7cf54de116b9a33341339fb' then
    raise exception 'rollback precondition failed, nothing changed (md5 %)', v_cur;
  end if;
  alter policy reg_select on public.session_registrations using (
    is_super_user(auth.uid())
    or ((user_id = auth.uid()) and (not is_registration_hidden(session_id, user_id)))
    or (is_coach(auth.uid()) and (not is_registration_hidden_from_coach(session_id, user_id)))
    or (is_manager(auth.uid()) and (not is_registration_hidden_from_manager(session_id, user_id)))
  );
  select md5(pg_get_expr(polqual, polrelid)) into v_cur from pg_policy where polname = 'reg_select' and polrelid = 'public.session_registrations'::regclass;
  if v_cur <> '79f246da6074eba07f62b57db6c18a43' then
    raise exception 'rollback post-check failed (md5 %), rolled back', v_cur;
  end if;
end
$$;
