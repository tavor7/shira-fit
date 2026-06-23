-- Stop blocking in send RPC (statement timeout). Client polls delivery status.

create or replace function public.get_whatsapp_delivery_status(p_delivery_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_delivery_id is null then
    return json_build_object('ok', false, 'error', 'missing_delivery');
  end if;

  select d.status, d.skip_reason, d.error_message, d.sent_at
  into v_row
  from public.notification_deliveries d
  where d.id = p_delivery_id
    and d.channel = 'whatsapp';

  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  return json_build_object(
    'ok', true,
    'status', v_row.status,
    'skip_reason', v_row.skip_reason,
    'error_message', v_row.error_message,
    'sent_at', v_row.sent_at
  );
end;
$$;

grant execute on function public.get_whatsapp_delivery_status(uuid) to authenticated;

create or replace function public.send_whatsapp_manager_test_message(
  p_user_id uuid,
  p_template text default 'hello_world'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text := public._whatsapp_rollout_mode();
  v_template text := lower(trim(coalesce(p_template, 'hello_world')));
  v_phone text;
  v_name text;
  v_delivery_id uuid;
  v_dedupe text;
  v_payload jsonb;
  v_session_date date;
  v_week_start date;
  v_week_end date;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_mode = 'off' then
    return json_build_object('ok', false, 'error', 'rollout_off');
  end if;

  if p_user_id is null then
    return json_build_object('ok', false, 'error', 'missing_user');
  end if;

  if v_template not in (
    'hello_world',
    'waitlist_spot',
    'session_reminder_24h',
    'session_reminder_3h',
    'weekly_registration_open'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_template');
  end if;

  select
    coalesce(p.whatsapp_phone_e164, public.normalize_phone_e164(p.phone)),
    p.full_name
  into v_phone, v_name
  from public.profiles p
  where p.user_id = p_user_id;

  if v_phone is null then
    return json_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  v_session_date := (timezone('Asia/Jerusalem', now()))::date + 1;
  v_week_start := public._week_start_sunday((timezone('Asia/Jerusalem', now()))::date) + 7;
  v_week_end := v_week_start + 6;

  v_payload := case v_template
    when 'hello_world' then jsonb_build_object(
      'template', v_template,
      'phone_e164', v_phone,
      'is_manager_test', true
    )
    when 'weekly_registration_open' then jsonb_build_object(
      'template', v_template,
      'phone_e164', v_phone,
      'week_start', v_week_start,
      'week_end', v_week_end,
      'week_label', to_char(v_week_start, 'DD/MM') || '–' || to_char(v_week_end, 'DD/MM'),
      'is_manager_test', true
    )
    else jsonb_build_object(
      'template', v_template,
      'phone_e164', v_phone,
      'session_date', v_session_date,
      'start_time', '10:00',
      'is_manager_test', true
    )
  end;

  v_dedupe := 'manager_test:' || p_user_id::text || ':' || extract(epoch from clock_timestamp())::bigint::text;

  insert into public.notification_deliveries (
    channel, user_id, notification_type, dedupe_key, payload, status
  )
  values (
    'whatsapp', p_user_id, 'manager_test', v_dedupe, v_payload, 'pending'
  )
  returning id into v_delivery_id;

  perform public.invoke_dispatch_notifications_edge();

  return json_build_object(
    'ok', true,
    'queued', true,
    'delivery_id', v_delivery_id,
    'user_name', v_name,
    'phone', v_phone,
    'template', v_template,
    'status', 'pending'
  );
end;
$$;
