-- Task 2 (notification template audit): evaluate_manager_operational_departure built the only
-- two push notification templates left in the entire codebase that were still English
-- (group_spot_available / nongroup_removal) -- every other notification type (athlete reminders,
-- weekly-registration-open, session-updated) is already Hebrew. This migration changes ONLY the
-- user-facing text: tier labels, title/body copy, and the date/time format string (was 'DD Mon',
-- an English month abbreviation -- now 'DD/MM' to match this codebase's other Hebrew notification
-- bodies, e.g. notify_weekly_registration_open_push / dispatch_due_session_push_reminders in
-- 20260910120000_restore_descriptive_titles.sql). Tier-name Hebrew wording matches the existing
-- subscriptions.tier.* i18n strings verbatim (mobile/src/i18n/translations.ts), not invented here.
-- Everything else -- recipient query, idempotency/dedupe insert, the dual Expo+web-push send
-- mechanics, error swallowing, recipients_notified counting -- is byte-for-byte unchanged.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'evaluate_manager_operational_departure') <> 1 then
    raise exception 'precondition: evaluate_manager_operational_departure must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'evaluate_manager_operational_departure')
     <> 'fb1cbd2dfde9e73c6968ef3eefbe83f6' then
    raise exception 'precondition: source of evaluate_manager_operational_departure differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public.evaluate_manager_operational_departure(
  p_session_id uuid,
  p_dedupe_key text,
  p_departed_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

comment on function public.evaluate_manager_operational_departure(uuid, text, text) is
  'The one authoritative boundary for both manager operational notification types. Recomputes '
  'occupancy and tier fresh from live state (never trusts caller-passed counts), decides '
  'group_spot_available (full -> not-full transition on a GROUP session) vs nongroup_removal (any '
  'departure from a NON-GROUP session), is idempotent via manager_operational_notifications''s '
  'unique dedupe_key, and fans out to opted-in, non-disabled managers only. Never raises -- a push '
  'outage can never fail the caller''s transaction. Notification copy is Hebrew (as of '
  '20261027210000), matching every other notification type in this codebase.';

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'evaluate_manager_operational_departure') <> 1 then
    raise exception 'self-check: evaluate_manager_operational_departure must exist exactly once';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'evaluate_manager_operational_departure')
     = 'fb1cbd2dfde9e73c6968ef3eefbe83f6' then
    raise exception 'self-check: evaluate_manager_operational_departure source is unchanged -- replace did not take effect';
  end if;
end $$;
