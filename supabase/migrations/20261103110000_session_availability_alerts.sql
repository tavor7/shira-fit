-- Per-session availability alerts: an athlete asks to be told when a full group session (capacity 7+) has a spot,
-- independently of its waitlist. No spot is reserved and registration stays first come, first served.
--
-- Rollout: everything is inert until system_monitoring_config has session_availability_enabled = true. While it is off
-- the triggers return immediately, the subscribe RPC refuses and the worker does nothing.
--
-- One opening row per genuine full -> available transition, one delivery row per recipient per opening.
-- Concurrency: the same per-session advisory lock as evaluate_manager_operational_departure serialises the occupancy
-- check, so simultaneous departures record one opening. Registration's row lock on training_sessions is not involved.
-- Transactions: rows and pg_net requests commit or roll back with the change that caused them.
-- Delivery: the first send happens in the same transaction (no artificial delay). A one-minute worker collects responses
-- and retries; retries carry an Idempotency-Key that send-web-push arbitrates. Eligibility is rechecked before every send.
-- A status of 'accepted' means send-web-push took the request. It is never proof that a device showed the notification.
-- A notification failure can never block the cancellation, removal or capacity change that caused it.

create table public.session_availability_subscriptions (
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index session_availability_subscriptions_user_idx on public.session_availability_subscriptions (user_id);

alter table public.session_availability_subscriptions enable row level security;
create policy session_availability_subscriptions_select on public.session_availability_subscriptions
  for select using (user_id = (select auth.uid()) or public.is_manager((select auth.uid())));
-- Writes go through the RPCs below only.
revoke all on public.session_availability_subscriptions from anon, authenticated;
grant select on public.session_availability_subscriptions to authenticated;

create table public.session_availability_openings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  cause text not null check (cause in ('registration_cancelled', 'manual_removed', 'capacity_increased')),
  occurred_at timestamptz not null default now()
);
create index session_availability_openings_session_idx on public.session_availability_openings (session_id, occurred_at desc);

create table public.session_availability_deliveries (
  id bigint generated always as identity primary key,
  opening_id uuid not null references public.session_availability_openings (id) on delete cascade,
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'accepted', 'skipped', 'failed')),
  skip_reason text,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  net_request_id bigint,
  devices_accepted integer,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (opening_id, user_id)
);
create index session_availability_deliveries_due_idx on public.session_availability_deliveries (next_attempt_at)
  where status = 'pending';
create index session_availability_deliveries_processing_idx on public.session_availability_deliveries (locked_at)
  where status = 'processing';
create index session_availability_deliveries_user_idx on public.session_availability_deliveries (user_id);
create index session_availability_deliveries_session_idx on public.session_availability_deliveries (session_id);

-- Internal bookkeeping: no client access at all (RLS on with no policies, and no grants).
alter table public.session_availability_openings enable row level security;
alter table public.session_availability_deliveries enable row level security;
revoke all on public.session_availability_openings from anon, authenticated;
revoke all on public.session_availability_deliveries from anon, authenticated;

-- Why this user must not be told about this session right now. Null means send.
create or replace function public._session_availability_skip_reason(p_session_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_sess public.training_sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_start timestamptz;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return 'session_not_found'; end if;

  if public.subscription_tier_for_capacity(v_sess.max_participants) is distinct from 'group' then return 'not_group_session'; end if;
  if coalesce(v_sess.is_hidden, false) then return 'session_hidden'; end if;
  if not coalesce(v_sess.is_open_for_registration, false) then return 'registration_closed'; end if;

  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');
  if now() >= v_start then return 'session_started'; end if;
  if v_sess.session_date > public.athlete_browse_week_end() then return 'outside_browse_window'; end if;
  if public.active_registration_count(p_session_id) >= v_sess.max_participants then return 'session_full'; end if;

  select * into v_profile from public.profiles where user_id = p_user_id;
  if not found then return 'user_not_found'; end if;
  if v_profile.disabled_at is not null then return 'account_disabled'; end if;
  if v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then return 'not_approved_athlete'; end if;

  if exists (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'active'
  ) then return 'already_registered'; end if;
  if not exists (
    select 1 from public.session_availability_subscriptions s
    where s.session_id = p_session_id and s.user_id = p_user_id
  ) then return 'not_subscribed'; end if;

  return null;
end;
$function$;

-- Sends one delivery row, or records why it did not. The caller holds the row.
create or replace function public._session_availability_dispatch_row(p_delivery_id bigint, p_url text, p_secret text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.session_availability_deliveries%rowtype;
  v_sess record;
  v_reason text;
  v_token text;
  v_title text := 'ייתכן שהתפנה מקום';
  v_body text;
  v_request_id bigint;
  v_has_web boolean;
begin
  select * into r from public.session_availability_deliveries where id = p_delivery_id;
  if not found or r.status <> 'pending' then return 'not_pending'; end if;

  v_reason := case
    when not public._system_flag('session_availability_enabled', false) then 'feature_disabled'
    when not public._push_notifications_enabled() then 'push_disabled'
    else public._session_availability_skip_reason(r.session_id, r.user_id)
  end;

  v_has_web := exists (select 1 from public.web_push_subscriptions w where w.user_id = r.user_id);
  select nullif(trim(p.expo_push_token), '') into v_token from public.profiles p where p.user_id = r.user_id;
  if v_reason is null and not v_has_web and v_token is null then
    -- Not a failure: the athlete still sees the in-app Home alert.
    v_reason := 'no_push_device';
  end if;

  if v_reason is not null then
    update public.session_availability_deliveries set status = 'skipped', skip_reason = v_reason where id = r.id;
    return 'skipped';
  end if;

  select session_date, start_time into v_sess from public.training_sessions where id = r.session_id;
  -- Always Hebrew, like every other push. Says plainly that nothing is reserved and that it can change.
  v_body := 'באימון ' || to_char(v_sess.session_date, 'DD/MM') || ' בשעה ' || to_char(v_sess.start_time, 'HH24:MI')
    || '. ההרשמה לפי סדר הגעה, ההתראה לא שומרת מקום והמקום עשוי להיתפס בכל רגע.';

  if v_token is not null and r.attempts = 0 then
    -- Native push has no idempotency layer, so it is sent once and not retried.
    begin
      perform net.http_post(
        url := 'https://exp.host/--/api/v2/push/send',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('to', v_token, 'title', v_title, 'body', v_body,
          'data', jsonb_build_object('session_id', r.session_id, 'kind', 'session_availability'))
      );
    exception when others then
      null;
    end;
  end if;

  if not v_has_web then
    update public.session_availability_deliveries set status = 'accepted', accepted_at = now(), devices_accepted = null where id = r.id;
    return 'accepted';
  end if;

  select net.http_post(
    url := trim(p_url),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(p_secret),
      'Idempotency-Key', r.idempotency_key
    ),
    body := jsonb_build_object(
      'user_id', r.user_id::text,
      'title', v_title,
      'body', v_body,
      'data', jsonb_build_object('session_id', r.session_id::text, 'kind', 'session_availability')
    )
  ) into v_request_id;

  update public.session_availability_deliveries
  set status = 'processing', locked_at = now(), net_request_id = v_request_id
  where id = r.id;
  return 'dispatched';
exception when others then
  update public.session_availability_deliveries
  set attempts = attempts + 1,
      last_error = 'dispatch_exception_' || sqlstate,
      status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
      next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second')
  where id = p_delivery_id;
  return 'error';
end;
$function$;

-- Records a genuine opening and sends right away. Must run after the row change it is reporting.
create or replace function public._session_availability_note_opening(p_session_id uuid, p_cause text, p_old_max integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sess record;
  v_occupied integer;
  v_opening uuid;
  v_first_waitlisted uuid;
  v_url text;
  v_secret text;
  r record;
begin
  if not public._system_flag('session_availability_enabled', false) then
    return;
  end if;

  -- Same lock as the manager check: held to commit, so concurrent changes to this session count occupancy one at a time.
  perform pg_advisory_xact_lock(hashtextextended('shira.session_occupancy:' || p_session_id::text, 0));

  select id, max_participants into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return;
  end if;
  if public.subscription_tier_for_capacity(v_sess.max_participants) is distinct from 'group' then
    return;
  end if;

  v_occupied := public.active_registration_count(p_session_id);
  if p_cause = 'capacity_increased' then
    -- Full under the old capacity, available under the new one.
    if not (v_occupied >= p_old_max and v_occupied < v_sess.max_participants) then
      return;
    end if;
  elsif v_occupied <> v_sess.max_participants - 1 then
    -- One departure caused full -> available iff occupancy is now exactly one below capacity. Over capacity stays full;
    -- further below means it already had space.
    return;
  end if;

  if not exists (select 1 from public.session_availability_subscriptions s where s.session_id = p_session_id) then
    return;
  end if;

  insert into public.session_availability_openings (session_id, cause)
  values (p_session_id, p_cause)
  returning id into v_opening;

  -- A departure also runs the waitlist push to the first eligible person in line (same rule as
  -- _waitlist_first_eligible_user). If they are subscribed too they get that one, not a second one. A capacity increase has no waitlist push, so nobody is skipped then.
  if p_cause <> 'capacity_increased' then
    select w.user_id into v_first_waitlisted
    from public.waitlist_requests w
    join public.profiles p on p.user_id = w.user_id
    where w.session_id = p_session_id
      and p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
      and not exists (
        select 1 from public.session_registrations reg
        where reg.session_id = p_session_id and reg.user_id = w.user_id and reg.status = 'active'
      )
    order by w.requested_at asc
    limit 1;
  end if;

  insert into public.session_availability_deliveries (opening_id, session_id, user_id, idempotency_key, status, skip_reason)
  select v_opening, p_session_id, s.user_id, 'avail:' || v_opening::text || ':' || s.user_id::text,
    case when s.user_id is not distinct from v_first_waitlisted then 'skipped' else 'pending' end,
    case when s.user_id is not distinct from v_first_waitlisted then 'waitlist_push_covers' end
  from public.session_availability_subscriptions s
  where s.session_id = p_session_id;

  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'send_web_push_url' limit 1;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'send_web_push_secret' limit 1;
  if v_url is null or v_secret is null or length(trim(v_url)) < 10 or length(trim(v_secret)) < 4 then
    return; -- The worker keeps these pending until the secrets exist or they expire.
  end if;

  for r in
    select id from public.session_availability_deliveries where opening_id = v_opening and status = 'pending' order by id
  loop
    perform public._session_availability_dispatch_row(r.id, v_url, v_secret);
  end loop;
end;
$function$;

create or replace function public.tg_session_availability_registration_departure()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public._session_availability_note_opening(new.session_id, 'registration_cancelled');
  return new;
exception when others then
  raise warning 'session availability: opening check failed (sqlstate %)', sqlstate;
  return new;
end;
$function$;

create or replace function public.tg_session_availability_manual_departure()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- A quick-add row linked to an athlete who also has an active registration never held a seat of its own
  -- (active_registration_count does not count it), so removing it opens nothing.
  if exists (
    select 1
    from public.manual_participants mp
    join public.session_registrations r on r.user_id = mp.linked_user_id and r.session_id = old.session_id and r.status = 'active'
    where mp.id = old.manual_participant_id
  ) then
    return old;
  end if;
  perform public._session_availability_note_opening(old.session_id, 'manual_removed');
  return old;
exception when others then
  raise warning 'session availability: opening check failed (sqlstate %)', sqlstate;
  return old;
end;
$function$;

create or replace function public.tg_session_availability_capacity_increase()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public._session_availability_note_opening(new.id, 'capacity_increased', old.max_participants);
  return new;
exception when others then
  raise warning 'session availability: opening check failed (sqlstate %)', sqlstate;
  return new;
end;
$function$;

-- A successful registration (self-service or by staff) ends the subscription. Runs whether or not the feature is on.
create or replace function public.tg_session_availability_clear_on_registration()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from public.session_availability_subscriptions
  where session_id = new.session_id and user_id = new.user_id;
  return new;
exception when others then
  raise warning 'session availability: subscription cleanup failed (sqlstate %)', sqlstate;
  return new;
end;
$function$;

create trigger trg_session_availability_registration_departure
  after update of status on public.session_registrations
  for each row
  when (old.status = 'active'::public.registration_status and new.status = 'cancelled'::public.registration_status)
  execute function public.tg_session_availability_registration_departure();

create trigger trg_session_availability_manual_departure
  after delete on public.session_manual_participants
  for each row
  execute function public.tg_session_availability_manual_departure();

create trigger trg_session_availability_capacity_increase
  after update of max_participants on public.training_sessions
  for each row
  when (new.max_participants > old.max_participants)
  execute function public.tg_session_availability_capacity_increase();

create trigger trg_session_availability_clear_on_registration
  after insert or update of status on public.session_registrations
  for each row
  when (new.status = 'active'::public.registration_status)
  execute function public.tg_session_availability_clear_on_registration();

-- Collects send-web-push responses, retries, expires what is too old to be useful, and tidies up.
create or replace function public._session_availability_outbox_process(p_batch_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_url text;
  v_secret text;
  v_ambiguous_after interval := interval '90 seconds';
  v_expire_after interval := interval '15 minutes';
  v_dispatched integer := 0;
  v_accepted integer := 0;
  v_requeued integer := 0;
  v_expired integer := 0;
  r record;
  v_status_code integer;
  v_content text;
  v_found boolean;
  v_devices integer;
begin
  if not public._system_flag('session_availability_enabled', false) then
    return jsonb_build_object('enabled', false);
  end if;

  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'send_web_push_url' limit 1;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'send_web_push_secret' limit 1;

  for r in
    select * from public.session_availability_deliveries
    where status = 'processing'
    order by locked_at
    limit p_batch_limit
    for update skip locked
  loop
    select d.status_code, d.content into v_status_code, v_content from net._http_response d where d.id = r.net_request_id;
    v_found := found;

    if v_found and v_status_code = 200 then
      begin
        v_devices := (v_content::jsonb ->> 'sent')::integer;
      exception when others then
        v_devices := null;
      end;
      update public.session_availability_deliveries
      set status = 'accepted', accepted_at = now(), devices_accepted = v_devices
      where id = r.id;
      v_accepted := v_accepted + 1;
    elsif (v_found) or r.locked_at < now() - v_ambiguous_after then
      -- A non-200 response, send-web-push's 202 "in flight", or no response in time. All retryable; the Idempotency-Key
      -- stops a retry from sending twice if the first attempt actually got through.
      update public.session_availability_deliveries
      set attempts = attempts + 1,
          last_error = case when v_found then 'http_status_' || v_status_code else 'no_response' end,
          status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
          next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second')
      where id = r.id;
      v_requeued := v_requeued + 1;
    end if;
  end loop;

  -- A retry long after the opening would mostly announce a spot that has gone.
  update public.session_availability_deliveries
  set status = 'skipped', skip_reason = 'expired'
  where status = 'pending' and created_at < now() - v_expire_after;
  get diagnostics v_expired = row_count;

  if v_url is not null and v_secret is not null and length(trim(v_url)) >= 10 and length(trim(v_secret)) >= 4 then
    for r in
      select id from public.session_availability_deliveries
      where status = 'pending' and next_attempt_at <= now()
      order by created_at
      limit p_batch_limit
      for update skip locked
    loop
      if public._session_availability_dispatch_row(r.id, v_url, v_secret) in ('dispatched', 'accepted') then
        v_dispatched := v_dispatched + 1;
      end if;
    end loop;
  end if;

  -- Subscription lifetime: a session that has started is finished with.
  delete from public.session_availability_subscriptions s
  using public.training_sessions t
  where t.id = s.session_id
    and t.session_date <= public._studio_today_date()
    and ((t.session_date + coalesce(t.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem') <= now();

  -- Retention.
  delete from public.session_availability_openings where occurred_at < now() - interval '90 days';
  delete from public.system_push_idempotency_keys where key like 'avail:%' and created_at < now() - interval '7 days';

  return jsonb_build_object('enabled', true, 'dispatched', v_dispatched, 'accepted', v_accepted, 'requeued', v_requeued, 'expired', v_expired);
exception when others then
  raise warning 'session availability: outbox processing failed (sqlstate %)', sqlstate;
  return jsonb_build_object('enabled', true, 'error', 'internal');
end;
$function$;

-- Client API.

create or replace function public.subscribe_session_availability(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_sess public.training_sessions%rowtype;
  v_start timestamptz;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public._system_flag('session_availability_enabled', false) then
    return jsonb_build_object('ok', false, 'error', 'feature_disabled');
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;
  if not found or v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  if v_profile.disabled_at is not null then
    return jsonb_build_object('ok', false, 'error', 'account_disabled');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found or coalesce(v_sess.is_hidden, false) or v_sess.session_date > public.athlete_browse_week_end() then
    return jsonb_build_object('ok', false, 'error', 'session_not_available');
  end if;
  if public.subscription_tier_for_capacity(v_sess.max_participants) is distinct from 'group' then
    return jsonb_build_object('ok', false, 'error', 'not_group_session');
  end if;

  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');
  if now() >= v_start then
    return jsonb_build_object('ok', false, 'error', 'session_started');
  end if;
  if not coalesce(v_sess.is_open_for_registration, false) then
    return jsonb_build_object('ok', false, 'error', 'registration_closed');
  end if;
  if exists (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_registered');
  end if;
  if public.active_registration_count(p_session_id) < v_sess.max_participants then
    return jsonb_build_object('ok', false, 'error', 'not_full');
  end if;

  insert into public.session_availability_subscriptions (session_id, user_id)
  values (p_session_id, v_uid)
  on conflict (session_id, user_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$function$;

-- Works with the feature off too, so nobody is ever stuck subscribed.
create or replace function public.unsubscribe_session_availability(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  delete from public.session_availability_subscriptions where session_id = p_session_id and user_id = v_uid;
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.session_availability_state(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  return jsonb_build_object(
    'ok', true,
    'enabled', public._system_flag('session_availability_enabled', false),
    'subscribed', exists (
      select 1 from public.session_availability_subscriptions s
      where s.session_id = p_session_id and s.user_id = v_uid
    )
  );
end;
$function$;

-- For the Home alert. Empty while the feature is off, so turning it off also removes the alert.
create or replace function public.my_session_availability_subscriptions()
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select s.session_id
  from public.session_availability_subscriptions s
  where s.user_id = auth.uid()
    and public._system_flag('session_availability_enabled', false);
$function$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public._session_availability_skip_reason(uuid, uuid)',
    'public._session_availability_dispatch_row(bigint, text, text)',
    'public._session_availability_note_opening(uuid, text, integer)',
    'public._session_availability_outbox_process(integer)',
    'public.tg_session_availability_registration_departure()',
    'public.tg_session_availability_manual_departure()',
    'public.tg_session_availability_capacity_increase()',
    'public.tg_session_availability_clear_on_registration()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.subscribe_session_availability(uuid)',
    'public.unsubscribe_session_availability(uuid)',
    'public.session_availability_state(uuid)',
    'public.my_session_availability_subscriptions()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

comment on table public.session_availability_subscriptions is
  'Athlete asked to be told when this full group session has a spot. Separate from waitlist_requests; reserves nothing.';
comment on table public.session_availability_openings is
  'One row per genuine full -> available transition of a group session that had subscribers.';
comment on table public.session_availability_deliveries is
  'One row per recipient per opening. status accepted = send-web-push took the request, not proof the device showed it.';

select cron.schedule('session-availability-outbox', '* * * * *', 'select public._session_availability_outbox_process();');
