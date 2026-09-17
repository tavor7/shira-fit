-- Manager-triggered, one-time re-prompt for users currently notifications-off (distinct
-- from notifications_onboarded_at, which gates the once-ever new-account onboarding
-- screen). A manager presses "Send prompt" in Alerts; every currently-inactive real
-- account gets this column stamped with now(); the client shows a popup on that user's
-- next app open and then clears its own flag (self-update, allowed by the existing
-- profiles_update_own RLS policy) whether they activated or skipped.
alter table public.profiles
  add column if not exists notification_prompt_queued_at timestamptz null;

create or replace function public.manager_queue_notification_activation_prompt()
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  with targets as (
    update public.profiles p
    set notification_prompt_queued_at = now()
    where p.role in ('athlete', 'coach', 'manager')
      and p.expo_push_token is null
      and not exists (select 1 from public.web_push_subscriptions w where w.user_id = p.user_id)
    returning 1
  )
  select count(*) into v_count from targets;

  return json_build_object('ok', true, 'queued', v_count);
end;
$$;

grant execute on function public.manager_queue_notification_activation_prompt() to authenticated;
