-- Task 1: optional manager-triggered Hebrew push announcement for a newly created GROUP session.
-- Reuses the existing athlete-broadcast recipient query and dual Expo+web-push send mechanics
-- (see notify_weekly_registration_open_push in 20260910120000_restore_descriptive_titles.sql) --
-- no parallel notification system. One announcement per creation action (single session, or the
-- whole series at once for a recurring series -- never one per occurrence, since that behavior was
-- never approved): the mobile client calls this once, passing the anchor/first occurrence's
-- session id. Idempotent per session_id so a client retry/duplicate request never double-sends.

create table if not exists public.group_session_announcements (
  session_id uuid primary key references public.training_sessions (id) on delete cascade,
  dispatched_at timestamptz not null default now(),
  dispatched_by uuid references public.profiles (user_id) on delete set null,
  recipients_notified int not null default 0
);

alter table public.group_session_announcements enable row level security;

drop policy if exists group_session_announcements_manager_select on public.group_session_announcements;
create policy group_session_announcements_manager_select on public.group_session_announcements
  for select
  using (public.is_manager(auth.uid()));

comment on table public.group_session_announcements is
  'Durable idempotency log for the optional "new group session" athlete announcement. Inserted '
  'only by manager_announce_group_session (SECURITY DEFINER); never client-writable. One row per '
  'announced session guarantees at most one dispatch per session, even under client retries.';

create or replace function public._hebrew_weekday_label(p_date date)
returns text
language sql
immutable
as $$
  select case extract(dow from p_date)::int
    when 0 then 'יום ראשון'
    when 1 then 'יום שני'
    when 2 then 'יום שלישי'
    when 3 then 'יום רביעי'
    when 4 then 'יום חמישי'
    when 5 then 'יום שישי'
    else 'שבת'
  end;
$$;

comment on function public._hebrew_weekday_label(date) is
  'Hebrew weekday name for a date, using the studio''s Sunday-Saturday week (extract(dow) 0=Sunday).';

create or replace function public.manager_announce_group_session(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess record;
  v_coach_name text;
  v_coach_gender text;
  v_coach_phrase text;
  v_title text := 'אימון קבוצתי חדש נוסף! 💪';
  v_body text;
  v_inserted boolean;
  v_push_on boolean := public._push_notifications_enabled();
  v_notified int := 0;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select ts.id, ts.session_date, ts.start_time, ts.max_participants, ts.is_hidden,
         ts.is_open_for_registration, ts.coach_id
  into v_sess
  from public.training_sessions ts
  where ts.id = p_session_id;

  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  if public.subscription_tier_for_capacity(v_sess.max_participants) <> 'group' then
    return json_build_object('ok', false, 'error', 'not_group');
  end if;

  if coalesce(v_sess.is_hidden, false) or not coalesce(v_sess.is_open_for_registration, false) then
    return json_build_object('ok', false, 'error', 'not_bookable');
  end if;

  if not v_push_on then
    -- Don't burn the one-shot dedupe row on a global push outage -- a retry once the kill
    -- switch is back on should still be able to send.
    return json_build_object('ok', false, 'error', 'push_disabled');
  end if;

  insert into public.group_session_announcements (session_id, dispatched_by)
  values (p_session_id, v_uid)
  on conflict (session_id) do nothing;

  get diagnostics v_inserted = row_count;
  if not v_inserted then
    return json_build_object('ok', true, 'already_sent', true);
  end if;

  select p.full_name, p.gender into v_coach_name, v_coach_gender
  from public.profiles p
  where p.user_id = v_sess.coach_id;

  v_coach_phrase := case
    when v_coach_name is null then 'המאמן/ת'
    when v_coach_gender = 'female' then 'המאמנת ' || v_coach_name
    else 'המאמן ' || v_coach_name
  end;

  v_body := 'נוסף אימון קבוצתי ביום ' || public._hebrew_weekday_label(v_sess.session_date)
    || ', ' || to_char(v_sess.session_date, 'DD/MM')
    || ', בשעה ' || to_char(v_sess.start_time, 'HH24:MI')
    || ', עם ' || v_coach_phrase || '. מחכים לכם!';

  for r in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
  loop
    if r.expo_push_token is not null and length(trim(r.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', r.expo_push_token,
            'title', v_title,
            'body', v_body,
            'data', jsonb_build_object('session_id', p_session_id, 'kind', 'group_session_announcement')
          )
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(
        r.user_id,
        v_title,
        v_body,
        jsonb_build_object('session_id', p_session_id::text, 'kind', 'group_session_announcement')
      );
    exception when others then
      null;
    end;

    v_notified := v_notified + 1;
  end loop;

  update public.group_session_announcements set recipients_notified = v_notified where session_id = p_session_id;

  return json_build_object('ok', true, 'recipients_notified', v_notified);
end;
$$;

comment on function public.manager_announce_group_session(uuid) is
  'Manager-only. Sends the optional Hebrew "new group session" push announcement to every '
  'eligible athlete (approved, not disabled) for a just-created GROUP session (subscription_tier_'
  'for_capacity = ''group''), skipping non-group/hidden/not-open-for-registration sessions as a '
  'no-op. Idempotent per session_id via group_session_announcements'' primary key -- a retry or '
  'duplicate request after the first successful dispatch returns {ok:true, already_sent:true} '
  'rather than resending. Never call before the session row itself has been successfully created.';

grant execute on function public.manager_announce_group_session(uuid) to authenticated;

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'manager_announce_group_session') <> 1 then
    raise exception 'self-check: manager_announce_group_session must exist exactly once';
  end if;
  if (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname = 'group_session_announcements') <> 1 then
    raise exception 'self-check: group_session_announcements table must exist exactly once';
  end if;
end $$;
