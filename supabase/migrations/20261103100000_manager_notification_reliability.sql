-- Manager "spot available" notifications: two reliability fixes. Who is notified, the wording, preferences and the
-- athlete-only actor gate are all unchanged.
--
-- 1. A later genuine opening was silently dropped. The dedupe key was 'reg_departure:<registration id>', permanent for
--    that row, but register_for_session re-activates the same row when an athlete comes back. So an athlete who
--    cancelled, re-registered and cancelled again never notified anyone the second time. The key now also names the
--    transaction, one per real active -> cancelled flip. A retried (rolled back) transaction still leaves one row only.
--
-- 2. Two simultaneous cancellations could both notify. cancel_registration takes no session lock, so under READ COMMITTED
--    each departure could count occupancy without seeing the other and both landed on max - 1. A per-session advisory
--    lock held to commit serialises the check: the second departure sees the first and lands on max - 2. Only this check
--    takes the lock, so registration's row lock on training_sessions is not affected. If it ever deadlocks,
--    tg_manager_notify_on_registration_departure's handler keeps the cancellation itself from failing.

create or replace function public.tg_manager_notify_on_registration_departure()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name text;
begin
  -- Only the departing athlete acting on their own registration should trigger this notification.
  -- auth.uid() is null (service-role/background job) or some other user's id (manager/coach
  -- removal, the source side of staff_move_session_participant, manager_revert_activity_event) in
  -- every other case.
  if auth.uid() is distinct from new.user_id then
    return new;
  end if;

  select full_name into v_name from public.profiles where user_id = new.user_id;
  perform public.evaluate_manager_operational_departure(
    new.session_id,
    'reg_departure:' || new.id::text || ':' || pg_current_xact_id()::text,
    v_name
  );
  return new;
exception
  when others then
    -- Never let a notification-side failure block the registration status change itself.
    return new;
end;
$function$;

create or replace function public.evaluate_manager_operational_departure(p_session_id uuid, p_dedupe_key text, p_departed_label text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sess record;
  v_tier public.subscription_tier;
  v_occupied int;
  v_event_kind text;
  v_title text;
  v_body text;
  v_when text;
  v_tier_label text;
  v_inserted_id uuid;
  v_push_on boolean := public._push_notifications_enabled();
  v_notified int := 0;
  r record;
begin
  -- Held to commit, so concurrent departures from this session count occupancy one at a time (see the header).
  perform pg_advisory_xact_lock(hashtextextended('shira.session_occupancy:' || p_session_id::text, 0));

  select id, session_date, start_time, max_participants
  into v_sess
  from public.training_sessions
  where id = p_session_id;

  if not found then
    return;
  end if;

  v_tier := public.subscription_tier_for_capacity(v_sess.max_participants);
  -- Live occupancy AFTER this departure has already been committed within the current
  -- transaction (the trigger fires after the status flip / delete) -- authoritative, never
  -- inferred from frontend state.
  v_occupied := public.active_registration_count(p_session_id);

  if v_tier = 'group' then
    -- This departure caused a full -> not-full transition iff occupancy immediately after it is
    -- exactly one below capacity: not-full-after requires occupied < max, and full-before (this
    -- being the ONE departure that just happened) requires occupied + 1 >= max. Both hold iff
    -- occupied = max - 1 -- a single self-contained check that needs no separate "before" snapshot
    -- and is correct regardless of any prior over-capacity state.
    if v_occupied <> v_sess.max_participants - 1 then
      return;
    end if;
    v_event_kind := 'group_spot_available';
  else
    v_event_kind := 'nongroup_removal';
  end if;

  -- Idempotency: at most one dispatch per logical departure, regardless of retries/reverts.
  insert into public.manager_operational_notifications (session_id, event_kind, dedupe_key)
  values (p_session_id, v_event_kind, p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    return;
  end if;

  v_when := to_char(v_sess.session_date, 'DD/MM') || ' בשעה ' || to_char(v_sess.start_time, 'HH24:MI');
  v_tier_label := case v_tier
    when 'personal' then 'אימון אישי'
    when 'pair' then 'אימון זוגי'
    when 'trio' then 'אימון בשלישייה'
    when 'quartet' then 'אימון ברביעייה'
    when 'quintet' then 'אימון בחמישייה'
    when 'sextet' then 'אימון בשישייה'
    else 'אימון קבוצתי'
  end;

  if v_event_kind = 'group_spot_available' then
    v_title := 'התפנה מקום!';
    v_body := 'התפנה מקום ב' || v_tier_label || ' · ' || v_when || '.';
  else
    v_title := 'ביטול השתתפות';
    v_body := coalesce(p_departed_label, 'מתאמן/ת') || ' עזב/ה את ה' || v_tier_label || ' · ' || v_when || '.';
  end if;

  for r in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.role = 'manager'
      and p.disabled_at is null
      and (
        (v_event_kind = 'group_spot_available' and p.notify_group_spot_available)
        or (v_event_kind = 'nongroup_removal' and p.notify_nongroup_removal)
      )
  loop
    if v_push_on then
      if r.expo_push_token is not null and length(trim(r.expo_push_token)) > 0 then
        begin
          perform net.http_post(
            url := 'https://exp.host/--/api/v2/push/send',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object(
              'to', r.expo_push_token,
              'title', v_title,
              'body', v_body,
              'data', jsonb_build_object('session_id', p_session_id, 'kind', v_event_kind)
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
          jsonb_build_object('session_id', p_session_id::text, 'kind', v_event_kind)
        );
      exception when others then
        null;
      end;
    end if;
    v_notified := v_notified + 1;
  end loop;

  update public.manager_operational_notifications set recipients_notified = v_notified where id = v_inserted_id;
end;
$function$;
