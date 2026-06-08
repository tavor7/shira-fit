-- Log staff/manager actions that previously had no activity-log entry.
-- Revert support for safe undo types is extended in the same migration (bottom).

-- ---------------------------------------------------------------------------
-- 1) Session updates: include custom slot price in diffs (revert already supported)
-- ---------------------------------------------------------------------------
create or replace function public.tg_training_sessions_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_changes jsonb := '{}'::jsonb;
  v_snap jsonb;
begin
  if tg_op = 'INSERT' then
    v_snap := jsonb_build_object(
      'session_date', new.session_date,
      'start_time', new.start_time::text,
      'coach_id', new.coach_id::text,
      'max_participants', new.max_participants,
      'is_open_for_registration', new.is_open_for_registration,
      'duration_minutes', new.duration_minutes,
      'is_hidden', new.is_hidden,
      'custom_slot_price_ils', new.custom_slot_price_ils
    );
    perform public._insert_activity_event(
      uid, 'session_created', 'training_session', new.id::text, jsonb_build_object('after', v_snap)
    );
  elsif tg_op = 'UPDATE' then
    if old.session_date is distinct from new.session_date then
      v_changes := v_changes || jsonb_build_object(
        'session_date', jsonb_build_object('from', old.session_date, 'to', new.session_date)
      );
    end if;
    if old.start_time is distinct from new.start_time then
      v_changes := v_changes || jsonb_build_object(
        'start_time', jsonb_build_object('from', old.start_time::text, 'to', new.start_time::text)
      );
    end if;
    if old.coach_id is distinct from new.coach_id then
      v_changes := v_changes || jsonb_build_object(
        'coach_id', jsonb_build_object('from', old.coach_id::text, 'to', new.coach_id::text)
      );
    end if;
    if old.max_participants is distinct from new.max_participants then
      v_changes := v_changes || jsonb_build_object(
        'max_participants', jsonb_build_object('from', old.max_participants, 'to', new.max_participants)
      );
    end if;
    if old.is_open_for_registration is distinct from new.is_open_for_registration then
      v_changes := v_changes || jsonb_build_object(
        'is_open_for_registration', jsonb_build_object('from', old.is_open_for_registration, 'to', new.is_open_for_registration)
      );
    end if;
    if old.duration_minutes is distinct from new.duration_minutes then
      v_changes := v_changes || jsonb_build_object(
        'duration_minutes', jsonb_build_object('from', old.duration_minutes, 'to', new.duration_minutes)
      );
    end if;
    if old.is_hidden is distinct from new.is_hidden then
      v_changes := v_changes || jsonb_build_object(
        'is_hidden', jsonb_build_object('from', old.is_hidden, 'to', new.is_hidden)
      );
    end if;
    if old.custom_slot_price_ils is distinct from new.custom_slot_price_ils then
      v_changes := v_changes || jsonb_build_object(
        'custom_slot_price_ils', jsonb_build_object('from', old.custom_slot_price_ils, 'to', new.custom_slot_price_ils)
      );
    end if;
    if v_changes <> '{}'::jsonb then
      perform public._insert_activity_event(
        uid, 'session_updated', 'training_session', new.id::text, jsonb_build_object('changes', v_changes)
      );
    end if;
  elsif tg_op = 'DELETE' then
    v_snap := jsonb_build_object(
      'session_date', old.session_date,
      'start_time', old.start_time::text,
      'coach_id', old.coach_id::text,
      'max_participants', old.max_participants,
      'is_open_for_registration', old.is_open_for_registration,
      'duration_minutes', old.duration_minutes,
      'is_hidden', old.is_hidden,
      'custom_slot_price_ils', old.custom_slot_price_ils
    );
    perform public._insert_activity_event(
      uid, 'session_deleted', 'training_session', old.id::text, jsonb_build_object('before', v_snap)
    );
  end if;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Table triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_session_manual_participants_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(),
      'session_manual_participant_added',
      'session_manual_participant',
      new.id::text,
      jsonb_build_object('session_id', new.session_id, 'manual_participant_id', new.manual_participant_id)
    );
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(),
      'session_manual_participant_removed',
      'session_manual_participant',
      old.id::text,
      jsonb_build_object('session_id', old.session_id, 'manual_participant_id', old.manual_participant_id)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_session_manual_participants_activity_ai on public.session_manual_participants;
create trigger trg_session_manual_participants_activity_ai
  after insert on public.session_manual_participants
  for each row execute procedure public.tg_session_manual_participants_activity();

drop trigger if exists trg_session_manual_participants_activity_ad on public.session_manual_participants;
create trigger trg_session_manual_participants_activity_ad
  after delete on public.session_manual_participants
  for each row execute procedure public.tg_session_manual_participants_activity();

create or replace function public.tg_manual_participants_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(),
      'manual_participant_created',
      'manual_participant',
      new.id::text,
      jsonb_build_object('full_name', coalesce(new.full_name, ''), 'phone', coalesce(new.phone, ''))
    );
  elsif tg_op = 'UPDATE' then
    if old.full_name is distinct from new.full_name then
      v_changes := v_changes || jsonb_build_object(
        'full_name', jsonb_build_object('from', coalesce(old.full_name, ''), 'to', coalesce(new.full_name, ''))
      );
    end if;
    if old.phone is distinct from new.phone then
      v_changes := v_changes || jsonb_build_object(
        'phone', jsonb_build_object('from', coalesce(old.phone, ''), 'to', coalesce(new.phone, ''))
      );
    end if;
    if v_changes <> '{}'::jsonb then
      perform public._insert_activity_event(
        auth.uid(),
        'manual_participant_updated',
        'manual_participant',
        new.id::text,
        jsonb_build_object('changes', v_changes)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_manual_participants_activity_ai on public.manual_participants;
create trigger trg_manual_participants_activity_ai
  after insert on public.manual_participants
  for each row execute procedure public.tg_manual_participants_activity();

drop trigger if exists trg_manual_participants_activity_au on public.manual_participants;
create trigger trg_manual_participants_activity_au
  after update on public.manual_participants
  for each row execute procedure public.tg_manual_participants_activity();

create or replace function public.tg_athlete_account_payments_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(),
      'account_payment_created',
      'athlete_account_payment',
      new.id::text,
      jsonb_build_object(
        'payee_id', new.payee_id,
        'payee_is_manual', new.payee_is_manual,
        'amount_ils', new.amount_ils,
        'payment_method', new.payment_method,
        'paid_at', new.paid_at,
        'payer_name', new.payer_name
      )
    );
  elsif tg_op = 'UPDATE' then
    if old.amount_ils is distinct from new.amount_ils then
      v_changes := v_changes || jsonb_build_object(
        'amount_ils', jsonb_build_object('from', old.amount_ils, 'to', new.amount_ils)
      );
    end if;
    if old.payment_method is distinct from new.payment_method then
      v_changes := v_changes || jsonb_build_object(
        'payment_method', jsonb_build_object('from', old.payment_method, 'to', new.payment_method)
      );
    end if;
    if old.paid_at is distinct from new.paid_at then
      v_changes := v_changes || jsonb_build_object(
        'paid_at', jsonb_build_object('from', old.paid_at, 'to', new.paid_at)
      );
    end if;
    if old.payer_name is distinct from new.payer_name then
      v_changes := v_changes || jsonb_build_object(
        'payer_name', jsonb_build_object('from', coalesce(old.payer_name, ''), 'to', coalesce(new.payer_name, ''))
      );
    end if;
    if v_changes <> '{}'::jsonb then
      perform public._insert_activity_event(
        auth.uid(),
        'account_payment_updated',
        'athlete_account_payment',
        new.id::text,
        jsonb_build_object('payee_id', new.payee_id, 'payee_is_manual', new.payee_is_manual, 'changes', v_changes)
      );
    end if;
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(),
      'account_payment_deleted',
      'athlete_account_payment',
      old.id::text,
      jsonb_build_object(
        'payee_id', old.payee_id,
        'payee_is_manual', old.payee_is_manual,
        'amount_ils', old.amount_ils,
        'payment_method', old.payment_method,
        'paid_at', old.paid_at,
        'payer_name', old.payer_name
      )
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_athlete_account_payments_activity on public.athlete_account_payments;
create trigger trg_athlete_account_payments_activity_ai
  after insert on public.athlete_account_payments
  for each row execute procedure public.tg_athlete_account_payments_activity();
create trigger trg_athlete_account_payments_activity_au
  after update on public.athlete_account_payments
  for each row execute procedure public.tg_athlete_account_payments_activity();
create trigger trg_athlete_account_payments_activity_ad
  after delete on public.athlete_account_payments
  for each row execute procedure public.tg_athlete_account_payments_activity();

create or replace function public.tg_pricing_settings_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(), 'pricing_setting_created', tg_table_name, new.id::text,
      jsonb_build_object('table', tg_table_name, 'after', to_jsonb(new))
    );
  elsif tg_op = 'UPDATE' then
    perform public._insert_activity_event(
      auth.uid(), 'pricing_setting_updated', tg_table_name, new.id::text,
      jsonb_build_object('table', tg_table_name, 'before', to_jsonb(old), 'after', to_jsonb(new))
    );
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(), 'pricing_setting_deleted', tg_table_name, old.id::text,
      jsonb_build_object('table', tg_table_name, 'before', to_jsonb(old))
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_session_capacity_pricing_activity on public.session_capacity_pricing;
create trigger trg_session_capacity_pricing_activity_ai after insert on public.session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_session_capacity_pricing_activity_au after update on public.session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_session_capacity_pricing_activity_ad after delete on public.session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();

drop trigger if exists trg_athlete_session_capacity_pricing_activity on public.athlete_session_capacity_pricing;
create trigger trg_athlete_session_capacity_pricing_activity_ai after insert on public.athlete_session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_athlete_session_capacity_pricing_activity_au after update on public.athlete_session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_athlete_session_capacity_pricing_activity_ad after delete on public.athlete_session_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();

drop trigger if exists trg_coach_capacity_pricing_activity on public.coach_capacity_pricing;
create trigger trg_coach_capacity_pricing_activity_ai after insert on public.coach_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_coach_capacity_pricing_activity_au after update on public.coach_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();
create trigger trg_coach_capacity_pricing_activity_ad after delete on public.coach_capacity_pricing
  for each row execute procedure public.tg_pricing_settings_activity();

create or replace function public.tg_studio_calendar_notes_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(), 'calendar_note_created', 'studio_calendar_note', new.id::text, to_jsonb(new)
    );
  elsif tg_op = 'UPDATE' then
    perform public._insert_activity_event(
      auth.uid(), 'calendar_note_updated', 'studio_calendar_note', new.id::text,
      jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
    );
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(), 'calendar_note_deleted', 'studio_calendar_note', old.id::text, to_jsonb(old)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_studio_calendar_notes_activity on public.studio_calendar_notes;
create trigger trg_studio_calendar_notes_activity_ai after insert on public.studio_calendar_notes
  for each row execute procedure public.tg_studio_calendar_notes_activity();
create trigger trg_studio_calendar_notes_activity_au after update on public.studio_calendar_notes
  for each row execute procedure public.tg_studio_calendar_notes_activity();
create trigger trg_studio_calendar_notes_activity_ad after delete on public.studio_calendar_notes
  for each row execute procedure public.tg_studio_calendar_notes_activity();

create or replace function public.tg_session_notes_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(), 'session_note_created', 'session_note', new.id::text,
      jsonb_build_object('session_id', new.session_id, 'body', new.body, 'author_id', new.author_id)
    );
  elsif tg_op = 'UPDATE' then
    if old.body is distinct from new.body then
      perform public._insert_activity_event(
        auth.uid(), 'session_note_updated', 'session_note', new.id::text,
        jsonb_build_object(
          'session_id', new.session_id,
          'changes', jsonb_build_object('body', jsonb_build_object('from', old.body, 'to', new.body))
        )
      );
    end if;
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(), 'session_note_deleted', 'session_note', old.id::text,
      jsonb_build_object('session_id', old.session_id, 'body', old.body, 'author_id', old.author_id)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_session_notes_activity on public.session_notes;
create trigger trg_session_notes_activity_ai after insert on public.session_notes
  for each row execute procedure public.tg_session_notes_activity();
create trigger trg_session_notes_activity_au after update on public.session_notes
  for each row execute procedure public.tg_session_notes_activity();
create trigger trg_session_notes_activity_ad after delete on public.session_notes
  for each row execute procedure public.tg_session_notes_activity();

create or replace function public.tg_waitlist_requests_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public._insert_activity_event(
      auth.uid(), 'waitlist_request_created', 'waitlist_request', new.id::text,
      jsonb_build_object('session_id', new.session_id, 'user_id', new.user_id)
    );
  elsif tg_op = 'DELETE' then
    perform public._insert_activity_event(
      auth.uid(), 'waitlist_request_removed', 'waitlist_request', old.id::text,
      jsonb_build_object('session_id', old.session_id, 'user_id', old.user_id)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_waitlist_requests_activity on public.waitlist_requests;
create trigger trg_waitlist_requests_activity_ai after insert on public.waitlist_requests
  for each row execute procedure public.tg_waitlist_requests_activity();
create trigger trg_waitlist_requests_activity_ad after delete on public.waitlist_requests
  for each row execute procedure public.tg_waitlist_requests_activity();

-- set_athlete_approval: use _insert_activity_event (respects skip flag during revert)
create or replace function public.set_athlete_approval(p_user_id uuid, p_status public.approval_status)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev public.approval_status;
  v_fn text;
  v_un text;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select p.approval_status, p.full_name, p.username
    into v_prev, v_fn, v_un
  from public.profiles p
  where p.user_id = p_user_id and p.role = 'athlete';

  if not found then
    return json_build_object('ok', false, 'error', 'not_athlete');
  end if;

  update public.profiles
  set approval_status = p_status
  where user_id = p_user_id and role = 'athlete';

  perform public._insert_activity_event(
    auth.uid(),
    case
      when p_status = 'approved'::public.approval_status then 'athlete_approved'
      when p_status = 'rejected'::public.approval_status then 'athlete_rejected'
      else 'athlete_approval_updated'
    end,
    'profile',
    p_user_id::text,
    jsonb_build_object(
      'target_user_id', p_user_id::text,
      'target_full_name', coalesce(v_fn, ''),
      'target_username', coalesce(v_un, ''),
      'previous_approval_status', v_prev::text,
      'new_approval_status', p_status::text
    )
  );
  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) RPC logging (attendance, role, billing settings, families, cancellations)
-- ---------------------------------------------------------------------------
create or replace function public.set_user_role(
  p_user_id uuid,
  p_role public.user_role
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.user_role;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select p.role into v_prev from public.profiles p where p.user_id = p_user_id;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;
  if v_prev = p_role then
    return json_build_object('ok', true);
  end if;

  update public.profiles set role = p_role where user_id = p_user_id;

  perform public._insert_activity_event(
    v_uid,
    'user_role_changed',
    'profile',
    p_user_id::text,
    jsonb_build_object('previous_role', v_prev::text, 'new_role', p_role::text)
  );

  return json_build_object('ok', true);
end;
$$;

create or replace function public.set_registration_opening_schedule(
  p_weekday int,
  p_time text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_t time;
  v_old_weekday int;
  v_old_time time;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_weekday is null or p_weekday < 0 or p_weekday > 6 then
    return json_build_object('ok', false, 'error', 'invalid_weekday');
  end if;
  begin
    v_t := p_time::time;
  exception when others then
    return json_build_object('ok', false, 'error', 'invalid_time');
  end;

  select s.registration_open_weekday, s.registration_open_time
    into v_old_weekday, v_old_time
  from public.app_settings s
  where s.id = 1;

  update public.app_settings
  set registration_open_weekday = p_weekday,
      registration_open_time = v_t,
      updated_at = now()
  where id = 1;

  perform public._insert_activity_event(
    v_uid,
    'registration_opening_schedule_updated',
    'app_settings',
    '1',
    jsonb_build_object(
      'changes', jsonb_build_object(
        'registration_open_weekday', jsonb_build_object('from', v_old_weekday, 'to', p_weekday),
        'registration_open_time', jsonb_build_object('from', v_old_time::text, 'to', v_t::text)
      )
    )
  );

  return json_build_object('ok', true);
end;
$$;

create or replace function public.manager_set_cancellation_charge(
  p_cancellation_id uuid,
  p_charge boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  s_row training_sessions%rowtype;
  v_start timestamptz;
  v_late boolean;
  v_new_penalty numeric(12, 2);
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  select * into s_row from public.training_sessions where id = c_row.session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_start :=
    ((s_row.session_date + coalesce(s_row.start_time, time '00:00'))::timestamp
      at time zone 'Asia/Jerusalem');

  v_late :=
    c_row.cancelled_at <= v_start
    and (v_start - c_row.cancelled_at) <= interval '12 hours';

  if not v_late then
    return json_build_object('ok', false, 'error', 'not_late_cancellation');
  end if;

  v_new_penalty := case when p_charge then c_row.penalty_collected_ils else 0 end;

  update public.cancellations
  set
    charged_full_price = p_charge,
    penalty_collected_ils = v_new_penalty
  where id = p_cancellation_id;

  perform public._insert_activity_event(
    v_uid,
    'cancellation_charge_updated',
    'cancellation',
    p_cancellation_id::text,
    jsonb_build_object(
      'session_id', c_row.session_id,
      'user_id', c_row.user_id,
      'changes', jsonb_build_object(
        'charged_full_price', jsonb_build_object('from', c_row.charged_full_price, 'to', p_charge),
        'penalty_collected_ils', jsonb_build_object('from', c_row.penalty_collected_ils, 'to', v_new_penalty)
      )
    )
  );

  return json_build_object('ok', true);
end;
$$;

create or replace function public.manager_set_cancellation_penalty_collected(
  p_cancellation_id uuid,
  p_collected_ils numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  s_row training_sessions%rowtype;
  v_price numeric(12, 2);
  v_amt numeric(12, 2);
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_collected_ils is null or p_collected_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if c_row.charged_full_price is not true then
    return json_build_object('ok', false, 'error', 'not_chargeable');
  end if;

  select * into s_row from public.training_sessions where id = c_row.session_id;
  v_price := round(
    public.effective_session_price_ils(
      c_row.user_id,
      s_row.max_participants,
      coalesce(s_row.is_kickbox, false),
      s_row.session_date
    )::numeric,
    2
  )::numeric(12, 2);
  if v_price is null then v_price := 0; end if;

  v_amt := least(round(p_collected_ils::numeric, 2), v_price)::numeric(12, 2);

  update public.cancellations
  set penalty_collected_ils = v_amt
  where id = p_cancellation_id;

  perform public._insert_activity_event(
    v_uid,
    'cancellation_penalty_collected_updated',
    'cancellation',
    p_cancellation_id::text,
    jsonb_build_object(
      'session_id', c_row.session_id,
      'user_id', c_row.user_id,
      'changes', jsonb_build_object(
        'penalty_collected_ils', jsonb_build_object('from', c_row.penalty_collected_ils, 'to', v_amt)
      )
    )
  );

  return json_build_object('ok', true);
end;
$$;

create or replace function public.delete_athlete_family(p_family_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_members jsonb;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_family_id is null then
    return json_build_object('ok', false, 'error', 'missing_family_id');
  end if;

  select f.name,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'kind', case when fm.user_id is not null then 'app' else 'manual' end,
          'id', coalesce(fm.user_id, fm.manual_participant_id)
        )
      ) filter (where fm.id is not null),
      '[]'::jsonb
    )
    into v_name, v_members
  from public.athlete_families f
  left join public.athlete_family_members fm on fm.family_id = f.id
  where f.id = p_family_id
  group by f.id, f.name;

  if v_name is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  delete from public.athlete_families where id = p_family_id;

  perform public._insert_activity_event(
    auth.uid(),
    'athlete_family_deleted',
    'athlete_family',
    p_family_id::text,
    jsonb_build_object('name', v_name, 'members', v_members)
  );

  return json_build_object('ok', true);
end;
$$;

create or replace function public.upsert_athlete_family(
  p_family_id uuid,
  p_name text,
  p_members jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_family_id uuid;
  v_name text;
  v_member jsonb;
  v_kind text;
  v_id uuid;
  v_other_family uuid;
  v_is_create boolean := false;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_name := trim(coalesce(p_name, ''));
  if char_length(v_name) = 0 then
    return json_build_object('ok', false, 'error', 'name_required');
  end if;

  if p_family_id is null then
    insert into public.athlete_families(name) values (v_name) returning id into v_family_id;
    v_is_create := true;
  else
    update public.athlete_families
    set name = v_name, updated_at = now()
    where id = p_family_id
    returning id into v_family_id;
    if v_family_id is null then
      return json_build_object('ok', false, 'error', 'not_found');
    end if;
    delete from public.athlete_family_members where family_id = v_family_id;
  end if;

  if jsonb_typeof(p_members) <> 'array' then
    return json_build_object('ok', false, 'error', 'invalid_members');
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    v_kind := lower(trim(coalesce(v_member->>'kind', '')));
    v_id := nullif(trim(v_member->>'id'), '')::uuid;

    if v_id is null or v_kind not in ('app', 'manual') then
      return json_build_object('ok', false, 'error', 'invalid_member');
    end if;

    if v_kind = 'app' then
      if not exists (
        select 1 from public.profiles pr where pr.user_id = v_id and pr.role = 'athlete'
      ) then
        return json_build_object('ok', false, 'error', 'invalid_athlete');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.user_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, user_id)
      values (v_family_id, v_id);
    else
      if not exists (select 1 from public.manual_participants mp where mp.id = v_id) then
        return json_build_object('ok', false, 'error', 'invalid_manual');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.manual_participant_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, manual_participant_id)
      values (v_family_id, v_id);
    end if;
  end loop;

  perform public._insert_activity_event(
    v_uid,
    case when v_is_create then 'athlete_family_created' else 'athlete_family_updated' end,
    'athlete_family',
    v_family_id::text,
    jsonb_build_object('name', v_name, 'members', p_members)
  );

  return json_build_object('ok', true, 'family_id', v_family_id);
end;
$$;

-- Attendance RPCs with before/after metadata
create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null,
  p_charge_no_show boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_row public.session_registrations%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
  v_charge_ns boolean := coalesce(p_charge_no_show, false);
  v_payment_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid
    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row
  from public.session_registrations
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  if not found then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
    v_charge_ns := false;
  elsif p_status = 'arrived' then
    v_att := true;
    v_charge_ns := false;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    if not v_charge_ns then
      v_pay := null;
      v_amt := null;
    else
      if v_pay is null then
        v_amt := null;
      else
        if p_amount_paid is not null and p_amount_paid < 0 then
          return json_build_object('ok', false, 'error', 'invalid_amount');
        end if;
        v_amt := case
          when p_amount_paid is null then null
          else round(p_amount_paid::numeric, 2)::numeric(12, 2)
        end;
      end if;
    end if;
  end if;

  if v_row.attended is distinct from v_att then
    v_changes := v_changes || jsonb_build_object(
      'attended', jsonb_build_object('from', v_row.attended, 'to', v_att)
    );
  end if;
  if nullif(trim(coalesce(v_row.payment_method, '')), '') is distinct from v_pay then
    v_changes := v_changes || jsonb_build_object(
      'payment_method', jsonb_build_object('from', v_row.payment_method, 'to', v_pay)
    );
  end if;
  if v_row.amount_paid is distinct from v_amt then
    v_changes := v_changes || jsonb_build_object(
      'amount_paid', jsonb_build_object('from', v_row.amount_paid, 'to', v_amt)
    );
  end if;
  if v_row.charge_no_show is distinct from (case when p_status = 'absent' then v_charge_ns else false end) then
    v_changes := v_changes || jsonb_build_object(
      'charge_no_show', jsonb_build_object('from', v_row.charge_no_show, 'to', case when p_status = 'absent' then v_charge_ns else false end)
    );
  end if;

  v_payment_changed :=
    v_pay is distinct from nullif(trim(coalesce(v_row.payment_method, '')), '')
    or v_amt is distinct from v_row.amount_paid;

  update public.session_registrations
  set
    attended = v_att,
    payment_method = v_pay,
    amount_paid = v_amt,
    charge_no_show = case when p_status = 'absent' then v_charge_ns else false end,
    payment_recorded_by = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then v_uid
      else v_row.payment_recorded_by
    end,
    payment_recorded_at = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then now()
      else v_row.payment_recorded_at
    end
  where id = v_row.id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'update_failed');
  end if;

  if v_changes <> '{}'::jsonb then
    perform public._insert_activity_event(
      v_uid,
      'registration_attendance_updated',
      'session_registration',
      v_row.id::text,
      jsonb_build_object('session_id', p_session_id, 'user_id', p_user_id, 'changes', v_changes)
    );
  end if;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.set_manual_participant_attendance(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null,
  p_charge_no_show boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_row public.session_manual_participants%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
  v_charge_ns boolean := coalesce(p_charge_no_show, false);
  v_payment_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row
  from public.session_manual_participants
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_in_session');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
    v_charge_ns := false;
  elsif p_status = 'arrived' then
    v_att := true;
    v_charge_ns := false;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    if not v_charge_ns then
      v_pay := null;
      v_amt := null;
    else
      if v_pay is null then
        v_amt := null;
      else
        if p_amount_paid is not null and p_amount_paid < 0 then
          return json_build_object('ok', false, 'error', 'invalid_amount');
        end if;
        v_amt := case
          when p_amount_paid is null then null
          else round(p_amount_paid::numeric, 2)::numeric(12, 2)
        end;
      end if;
    end if;
  end if;

  if v_row.attended is distinct from v_att then
    v_changes := v_changes || jsonb_build_object(
      'attended', jsonb_build_object('from', v_row.attended, 'to', v_att)
    );
  end if;
  if nullif(trim(coalesce(v_row.payment_method, '')), '') is distinct from v_pay then
    v_changes := v_changes || jsonb_build_object(
      'payment_method', jsonb_build_object('from', v_row.payment_method, 'to', v_pay)
    );
  end if;
  if v_row.amount_paid is distinct from v_amt then
    v_changes := v_changes || jsonb_build_object(
      'amount_paid', jsonb_build_object('from', v_row.amount_paid, 'to', v_amt)
    );
  end if;
  if v_row.charge_no_show is distinct from (case when p_status = 'absent' then v_charge_ns else false end) then
    v_changes := v_changes || jsonb_build_object(
      'charge_no_show', jsonb_build_object('from', v_row.charge_no_show, 'to', case when p_status = 'absent' then v_charge_ns else false end)
    );
  end if;

  v_payment_changed :=
    v_pay is distinct from nullif(trim(coalesce(v_row.payment_method, '')), '')
    or v_amt is distinct from v_row.amount_paid;

  update public.session_manual_participants
  set
    attended = v_att,
    payment_method = v_pay,
    amount_paid = v_amt,
    charge_no_show = case when p_status = 'absent' then v_charge_ns else false end,
    payment_recorded_by = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then v_uid
      else v_row.payment_recorded_by
    end,
    payment_recorded_at = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then now()
      else v_row.payment_recorded_at
    end
  where id = v_row.id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'update_failed');
  end if;

  if v_changes <> '{}'::jsonb then
    perform public._insert_activity_event(
      v_uid,
      'manual_participant_attendance_updated',
      'session_manual_participant',
      v_row.id::text,
      jsonb_build_object(
        'session_id', p_session_id,
        'manual_participant_id', p_manual_participant_id,
        'changes', v_changes
      )
    );
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_attendance(uuid, uuid, text, text, numeric, boolean) to authenticated;
grant execute on function public.set_manual_participant_attendance(uuid, uuid, text, text, numeric, boolean) to authenticated;
