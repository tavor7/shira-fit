-- Manager tool: compose and send an arbitrary push notification to every user.
-- Unlike send_test_push_notification (self-only, bypasses the kill switch on purpose as
-- a diagnostic), this is a real broadcast — it respects the kill switch like every other
-- real send path.

create or replace function public.send_custom_push_notification(p_title text, p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := trim(coalesce(p_title, ''));
  v_body text := trim(coalesce(p_body, ''));
  v_row record;
  v_count int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_title = '' or v_body = '' then
    return json_build_object('ok', false, 'error', 'title_and_body_required');
  end if;
  if not public._push_notifications_enabled() then
    return json_build_object('ok', false, 'error', 'push_disabled');
  end if;

  for v_row in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.disabled_at is null
      and (p.role != 'athlete' or p.approval_status = 'approved')
  loop
    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('to', v_row.expo_push_token, 'title', v_title, 'body', v_body)
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(v_row.user_id, v_title, v_body, '{}'::jsonb);
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return json_build_object('ok', true, 'notified', v_count);
end;
$$;

comment on function public.send_custom_push_notification(text, text) is
  'Manager broadcast: sends an arbitrary title/body push (Expo + Web) to every non-disabled user (approved athletes, all coaches/managers). Respects the kill switch.';

grant execute on function public.send_custom_push_notification(text, text) to authenticated;
