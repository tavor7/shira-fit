-- Allow adding the same staff note to multiple newly-created sessions in one call.
-- Used by CreateSessionForm when "Repeat weekly" is enabled.

create or replace function public.add_session_note_many(p_session_ids uuid[], p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := nullif(trim(p_body), '');
  v_total int;
  v_allowed int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_body is null then
    return json_build_object('ok', true, 'inserted', 0);
  end if;

  v_total := coalesce(array_length(p_session_ids, 1), 0);
  if v_total = 0 then
    return json_build_object('ok', true, 'inserted', 0);
  end if;

  -- Authorization: managers can add notes anywhere; coaches only for their own sessions.
  select count(*) into v_allowed
  from public.training_sessions s
  where s.id = any(p_session_ids)
    and (
      public.is_manager(v_uid)
      or s.coach_id = v_uid
    );

  if v_allowed <> v_total then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  insert into public.session_notes (session_id, author_id, body)
  select sid, v_uid, v_body
  from unnest(p_session_ids) as sid;

  get diagnostics v_allowed = row_count;
  return json_build_object('ok', true, 'inserted', v_allowed);
end;
$$;

grant execute on function public.add_session_note_many(uuid[], text) to authenticated;

