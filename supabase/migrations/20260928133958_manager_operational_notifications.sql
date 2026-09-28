-- Manager operational notifications: (A) a GROUP session transitions FULL -> NOT FULL, and
-- (B) a participant is removed from a NON-GROUP session. Per-manager opt-in preferences, both
-- defaulting to ON. Reuses the existing push infrastructure (net.http_post to Expo directly,
-- invoke_send_web_push_edge for web) and the existing canonical group/non-group definition
-- (subscription_tier_for_capacity) -- no parallel notification system, no second "is this a group
-- session" definition.
--
-- Investigation finding worth recording: this codebase's waitlist system
-- (notify_waitlist_on_spot_open) does NOT auto-promote a waitlisted athlete into the newly-open
-- spot -- it only pushes "a spot opened, come register" to the first waitlisted athlete, who must
-- then complete registration themselves through the normal register_for_session flow, exactly like
-- anyone else. There is no synchronous (or asynchronous) atomic promotion transaction to race
-- against. The "final committed state" this feature must respect is therefore simply: the state of
-- session_registrations/session_manual_participants at the moment this departure's own transaction
-- commits -- which is exactly what evaluating occupancy inside an AFTER trigger on that same
-- transaction gives us. No delayed/re-queried evaluation is needed for correctness here (unlike
-- notify-waitlist's edge function, which re-queries because ITS send happens from a separate,
-- later HTTP-triggered process with no transactional relationship to the original cancellation).

-- ---------------------------------------------------------------------------
-- 1. Per-manager preferences -- authoritative column defaults, not just a UI fallback. Applies to
--    every existing manager immediately (ALTER TABLE ... DEFAULT backfills existing rows) and to
--    every future one via the same column default.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists notify_group_spot_available boolean not null default true,
  add column if not exists notify_nongroup_removal boolean not null default true;

comment on column public.profiles.notify_group_spot_available is
  'Manager-only preference: receive a push when a GROUP session (subscription_tier_for_capacity = '
  '''group'') transitions from full to not-full. Defaults to true for every manager.';
comment on column public.profiles.notify_nongroup_removal is
  'Manager-only preference: receive a push when a participant is removed/cancels from any '
  'NON-GROUP session. Defaults to true for every manager.';

-- ---------------------------------------------------------------------------
-- 2. Durable idempotency log -- one row per logical departure event that was actually dispatched.
--    dedupe_key ties directly to the specific registration/manual-participant row that departed
--    (never to the session alone), so the same session can legitimately generate this event again
--    later (full -> not-full -> full -> not-full), while a retried/duplicated trigger firing for
--    the EXACT SAME departure can never dispatch twice.
-- ---------------------------------------------------------------------------

create table if not exists public.manager_operational_notifications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  event_kind text not null check (event_kind in ('group_spot_available', 'nongroup_removal')),
  dedupe_key text not null,
  recipients_notified int not null default 0,
  created_at timestamptz not null default now(),
  constraint manager_operational_notifications_dedupe_uidx unique (dedupe_key)
);

create index if not exists manager_operational_notifications_session_idx
  on public.manager_operational_notifications (session_id, created_at desc);

alter table public.manager_operational_notifications enable row level security;

drop policy if exists manager_operational_notifications_manager_select on public.manager_operational_notifications;
create policy manager_operational_notifications_manager_select on public.manager_operational_notifications
  for select
  using (public.is_manager(auth.uid()));

comment on table public.manager_operational_notifications is
  'Durable idempotency log for the two manager operational notification types. Inserted only by '
  'evaluate_manager_operational_departure (SECURITY DEFINER); never client-writable. A unique '
  'dedupe_key per departing registration/manual-participant row guarantees at most one dispatch per '
  'logical event, even under RPC retries or activity-log reverts replaying the same status change.';

-- ---------------------------------------------------------------------------
-- 3. Preference RPCs -- self-only, mirroring get_push_kill_switch/set_push_kill_switch's exact
--    shape, but scoped to the CALLING manager's own row instead of the global app_settings row.
-- ---------------------------------------------------------------------------

create or replace function public.get_manager_notification_prefs()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group boolean;
  v_nongroup boolean;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select notify_group_spot_available, notify_nongroup_removal
  into v_group, v_nongroup
  from public.profiles
  where user_id = v_uid;

  return json_build_object(
    'ok', true,
    'notify_group_spot_available', coalesce(v_group, true),
    'notify_nongroup_removal', coalesce(v_nongroup, true)
  );
end;
$$;

comment on function public.get_manager_notification_prefs() is
  'Self-only. Returns the calling manager''s own two operational-notification preferences.';

grant execute on function public.get_manager_notification_prefs() to authenticated;

create or replace function public.set_manager_notification_prefs(
  p_notify_group_spot_available boolean,
  p_notify_nongroup_removal boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_notify_group_spot_available is null or p_notify_nongroup_removal is null then
    return json_build_object('ok', false, 'error', 'both_flags_required');
  end if;

  update public.profiles
  set notify_group_spot_available = p_notify_group_spot_available,
      notify_nongroup_removal = p_notify_nongroup_removal
  where user_id = v_uid;

  return json_build_object(
    'ok', true,
    'notify_group_spot_available', p_notify_group_spot_available,
    'notify_nongroup_removal', p_notify_nongroup_removal
  );
end;
$$;

comment on function public.set_manager_notification_prefs(boolean, boolean) is
  'Self-only. Updates the calling manager''s own two operational-notification preferences. '
  'auth.uid() decides whose row is updated -- never a client-supplied user id -- and is_manager() '
  'is re-checked server-side so an athlete/coach can never grant themselves manager notification '
  'behavior regardless of what a client sends.';

grant execute on function public.set_manager_notification_prefs(boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The one authoritative evaluator, called by both trigger paths below. Recomputes occupancy
--    fresh (never trusts a value passed in), decides the event kind from the SAME canonical
--    subscription_tier_for_capacity used by the subscription system, and fans out via the
--    existing dual push-send pattern (notify_session_participants_updated's exact shape) --
--    per-send failures are swallowed so a push outage can never fail the caller's transaction.
-- ---------------------------------------------------------------------------

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

  v_when := to_char(v_sess.session_date, 'DD Mon') || ' at ' || to_char(v_sess.start_time, 'HH24:MI');
  v_tier_label := case v_tier
    when 'personal' then 'Personal Training'
    when 'pair' then 'Pair Training'
    when 'trio' then 'Trio Training'
    when 'quartet' then 'Quartet Training'
    when 'quintet' then 'Quintet Training'
    when 'sextet' then 'Sextet Training'
    else 'Group Training'
  end;

  if v_event_kind = 'group_spot_available' then
    v_title := 'Spot available';
    v_body := 'A spot opened in ' || v_tier_label || ' · ' || v_when || '.';
  else
    v_title := 'Participant cancelled';
    v_body := coalesce(p_departed_label, 'A participant') || ' left ' || v_tier_label || ' · ' || v_when || '.';
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
  'delivery failure must never fail the caller''s registration/cancellation transaction.';

-- No grant: internal helper invoked only from the two trigger functions below (SECURITY DEFINER,
-- need no separate grant), matching this codebase's established convention for trigger-only logic.

-- ---------------------------------------------------------------------------
-- 5. Triggers on the exact same two events the existing waitlist-promotion-notice system already
--    listens to (session_registrations active->cancelled, session_manual_participants delete) --
--    these fire for EVERY authoritative removal path already identified (athlete self-cancel,
--    manager_remove_athlete, coach_remove_athlete, remove_manual_participant_from_session,
--    staff_move_session_participant's source-session decrement, and manager_revert_activity_event's
--    both revert branches), so no individual RPC needs its own instrumentation.
-- ---------------------------------------------------------------------------

create or replace function public.tg_manager_notify_on_registration_departure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select full_name into v_name from public.profiles where user_id = new.user_id;
  perform public.evaluate_manager_operational_departure(
    new.session_id,
    'reg_departure:' || new.id::text,
    v_name
  );
  return new;
exception
  when others then
    -- Never let a notification-side failure block the registration status change itself.
    return new;
end;
$$;

drop trigger if exists trg_manager_notify_on_registration_departure on public.session_registrations;
create trigger trg_manager_notify_on_registration_departure
  after update of status on public.session_registrations
  for each row
  when (old.status = 'active'::public.registration_status and new.status = 'cancelled'::public.registration_status)
  execute procedure public.tg_manager_notify_on_registration_departure();

create or replace function public.tg_manager_notify_on_manual_departure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select full_name into v_name from public.manual_participants where id = old.manual_participant_id;
  perform public.evaluate_manager_operational_departure(
    old.session_id,
    'manual_departure:' || old.id::text,
    v_name
  );
  return old;
exception
  when others then
    return old;
end;
$$;

drop trigger if exists trg_manager_notify_on_manual_departure on public.session_manual_participants;
create trigger trg_manager_notify_on_manual_departure
  after delete on public.session_manual_participants
  for each row
  execute procedure public.tg_manager_notify_on_manual_departure();

comment on function public.tg_manager_notify_on_registration_departure() is
  'Fires on every active->cancelled status flip (athlete self-cancel, manager/coach removal, the '
  'source side of staff_move_session_participant, and manager_revert_activity_event''s registration '
  'revert, which itself calls manager_remove_athlete) -- the single attachment point for manager '
  'operational notifications on the app-registration path.';
comment on function public.tg_manager_notify_on_manual_departure() is
  'Fires on every session_manual_participants delete (direct removal, the source side of a staff '
  'move, and manager_revert_activity_event''s manual-participant-added revert) -- the single '
  'attachment point for the manual-participant path.';
