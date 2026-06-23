-- Supabase blocks DELETE without WHERE; use WHERE true for full-table replace.

create or replace function public.set_whatsapp_test_users(p_user_ids uuid[])
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_ids := array(
    select distinct unnest(coalesce(p_user_ids, array[]::uuid[]))
  );

  delete from public.whatsapp_test_users where true;

  if array_length(v_ids, 1) is not null then
    insert into public.whatsapp_test_users (user_id, added_by)
    select x.uid, v_uid
    from unnest(v_ids) as x(uid)
    where exists (select 1 from public.profiles p where p.user_id = x.uid);
  end if;

  return json_build_object('ok', true, 'count', coalesce(array_length(v_ids, 1), 0));
end;
$$;

create or replace function public.save_whatsapp_rollout_config(
  p_mode text,
  p_user_ids jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text := lower(trim(coalesce(p_mode, '')));
  v_count int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_mode not in ('off', 'testing', 'live') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  update public.app_settings
  set whatsapp_rollout_mode = v_mode,
      updated_at = now()
  where id = 1;

  delete from public.whatsapp_test_users where true;

  if v_mode = 'testing' and jsonb_typeof(coalesce(p_user_ids, '[]'::jsonb)) = 'array' then
    insert into public.whatsapp_test_users (user_id, added_by)
    select x.uid::uuid, v_uid
    from jsonb_array_elements_text(coalesce(p_user_ids, '[]'::jsonb)) as x(uid)
    where exists (select 1 from public.profiles p where p.user_id = x.uid::uuid);

    get diagnostics v_count = row_count;
  end if;

  return json_build_object('ok', true, 'mode', v_mode, 'count', v_count);
end;
$$;
