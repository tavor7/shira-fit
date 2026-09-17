-- Manager-only: how many real accounts (athlete/coach/manager — never manual/quick-add
-- participants, which have no login and can't receive push at all) have push
-- notifications actually activated, vs. the total. "Activated" means the device wrote a
-- live token: profiles.expo_push_token (native) or a row in web_push_subscriptions (web).
-- Toggle prefs themselves live only in local device storage, so this token/subscription
-- presence is the only server-visible signal of "did this person turn notifications on."
create or replace function public.manager_notification_activation_stats()
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_total int;
  v_active int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select
    count(*),
    count(*) filter (
      where p.expo_push_token is not null
        or exists (select 1 from public.web_push_subscriptions w where w.user_id = p.user_id)
    )
  into v_total, v_active
  from public.profiles p
  where p.role in ('athlete', 'coach', 'manager');

  return json_build_object('ok', true, 'total_users', v_total, 'active_users', v_active);
end;
$$;

grant execute on function public.manager_notification_activation_stats() to authenticated;
