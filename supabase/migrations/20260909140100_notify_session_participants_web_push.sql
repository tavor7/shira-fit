-- Extend notify_session_participants_updated to also fan out to web push subscribers,
-- alongside the existing native Expo push. Same function, same trigger call sites — only
-- the body gains one more delivery attempt per participant.

create or replace function public.notify_session_participants_updated(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess record;
  v_body text;
  v_notified int := 0;
  r record;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select id, session_date, start_time into v_sess
  from public.training_sessions
  where id = p_session_id;

  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  v_body := 'The details of your training session on ' || to_char(v_sess.session_date, 'YYYY-MM-DD')
    || ' at ' || to_char(v_sess.start_time, 'HH24:MI') || ' were updated by the studio. '
    || 'Please check the app for the latest details.';

  for r in
    select p.user_id, p.expo_push_token
    from public.session_registrations reg
    join public.profiles p on p.user_id = reg.user_id
    where reg.session_id = p_session_id
      and reg.status = 'active'
  loop
    begin
      insert into public.manager_direct_messages (sender_id, recipient_id, body)
      values (v_uid, r.user_id, v_body);
      v_notified := v_notified + 1;
    exception when others then
      null;
    end;

    if r.expo_push_token is not null and length(trim(r.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', r.expo_push_token,
            'title', 'Session updated',
            'body', v_body,
            'data', jsonb_build_object('session_id', p_session_id)
          )
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(
        r.user_id,
        'Session updated',
        v_body,
        jsonb_build_object('session_id', p_session_id::text)
      );
    exception when others then
      null;
    end;
  end loop;

  return json_build_object('ok', true, 'notified', v_notified);
end;
$$;

grant execute on function public.notify_session_participants_updated(uuid) to authenticated;
