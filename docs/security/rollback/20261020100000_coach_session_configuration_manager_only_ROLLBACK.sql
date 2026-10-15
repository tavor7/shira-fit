-- ROLLBACK for 20261020100000_coach_session_configuration_manager_only.sql
--
-- !!! SECURITY-SENSITIVE: applying this REOPENS V1-V10 (any coach can again delete any session, rewrite any recurring
-- !!! series, create sessions, change capacity and prices of their sessions, add over capacity, move walk-ins by direct
-- !!! write, and signed-out callers regain EXECUTE on these functions). Apply ONLY with explicit owner approval, and only
-- !!! when a targeted corrective migration that keeps the restrictions is not possible. It is NOT in supabase/migrations
-- !!! on purpose, so it can never be applied by a routine "db push".
--
-- What it restores (verbatim from production, 2026-10-15): the eleven function definitions, the four replaced RLS
-- policies (session_series, session_roster_slot_prices, session_notes update/delete, session_manual_participants update),
-- EXECUTE for PUBLIC/anon on the eleven functions and TRUNCATE for anon/authenticated on the seven tables.
-- No data is touched: the migration changed no data, so there is nothing to restore there.
--
-- Precondition: aborts, changing nothing, unless every function is exactly the version the migration installed.

do $pre$
declare
  v_bad text := '';
  r record;
begin
  for r in select * from (values
    ('public._coach_add_athlete_core(uuid,uuid,boolean,boolean,uuid)', '7beee6ed572c6021e9d24465bf25089a'),
    ('public.add_manual_participant_to_session(uuid,uuid,boolean,boolean)', '11675eeaaf5775ffa1f53673252aa1f0'),
    ('public.delete_session_note(uuid)', '5e59c97a67de6aa4dd1274b64039555a'),
    ('public.maintain_session_series_horizon()', 'fc7901bb36cebee74e12911fc1626d9e'),
    ('public.reconcile_series_duplicate_sessions()', 'd997dcbf18d47deb85c771d60cac38e8'),
    ('public.staff_create_session_series(date,time without time zone,uuid,integer,integer,boolean,boolean,boolean,numeric,text,integer,boolean,uuid[],uuid[])', '34155bfa4cf206f1a3d0c4d0fa441a3d'),
    ('public.staff_delete_session_series_scope(uuid,text)', 'd3dabc884d0bf75538b19d2a1b3376a3'),
    ('public.staff_move_session_participant(uuid,uuid,uuid,uuid,boolean,boolean,boolean,boolean)', 'fa403ec2c96cd612aa661b5e257bd11d'),
    ('public.staff_set_session_custom_slot_price(uuid,numeric)', '7a099b33af0f7d7506a439279e19c7aa'),
    ('public.staff_set_session_roster_slot_price(uuid,uuid,uuid,numeric)', 'c9ee2624103139b09f6a5f4c8771edb8'),
    ('public.staff_update_session_series_scope(uuid,text,date,time without time zone,uuid,integer,integer,boolean,boolean,boolean,numeric)', 'e623ca1e2ea7c00e3a6d0b558d77e2d0')
  ) as t(fn, h) loop
    if to_regprocedure(r.fn) is null then
      v_bad := v_bad || ' missing:' || r.fn;
    elsif (select md5(prosrc) from pg_proc where oid = to_regprocedure(r.fn)) <> r.h then
      v_bad := v_bad || ' not-the-migrated-version:' || r.fn;
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'rollback precondition failed, nothing changed:%', v_bad;
  end if;
end
$pre$;

CREATE OR REPLACE FUNCTION public.staff_delete_session_series_scope(p_session_id uuid, p_scope text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_occurrence_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  if v_sess.series_id is null then
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    -- Forward-only fix: atomically establish-or-retrieve a durable tombstone for this
    -- occurrence, using pre-delete values, before the physical delete. Protects both this
    -- series (never regenerates) and blocks a sibling series from claiming the vacated slot.
    if v_sess.series_occurrence_id is not null then
      update public.session_series_occurrences
      set state = 'deleted', training_session_id = null
      where id = v_sess.series_occurrence_id;
    else
      begin
        insert into public.session_series_occurrences (
          series_id, template_occurrence_date, template_coach_id, template_start_time, state
        )
        values (v_sess.series_id, v_sess.session_date, v_sess.coach_id, v_sess.start_time, 'deleted')
        on conflict (series_id, template_occurrence_date) do nothing
        returning id into v_occurrence_id;
      exception when unique_violation then
        -- A sibling series already owns this exact original slot -- it's already protected;
        -- the delete proceeds regardless.
        null;
      end;
    end if;

    -- Pre-existing skip_dates protection, unchanged.
    perform public._series_add_skip_date(v_sess.series_id, v_sess.session_date);

    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  -- 'future' scope: end the series from this date, tombstone linked occurrences, delete the sessions.
  update public.session_series
  set
    status = 'ended',
    ended_from_date = v_sess.session_date,
    updated_at = now()
  where id = v_sess.series_id;

  -- Tombstone the ledger rows of the sessions about to be deleted so the ON DELETE SET NULL on
  -- training_sessions.series_occurrence_id does not violate the materialized-requires-session check.
  update public.session_series_occurrences o
  set state = 'deleted', training_session_id = null
  where o.training_session_id in (
    select t.id from public.training_sessions t
    where t.series_id = v_sess.series_id
      and t.session_date >= v_sess.session_date
      and t.series_detached = false
  );

  delete from public.training_sessions t
  where t.series_id = v_sess.series_id
    and t.session_date >= v_sess.session_date
    and t.series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_create_session_series(p_anchor_date date, p_start_time time without time zone, p_coach_id uuid, p_max_participants integer, p_duration_minutes integer DEFAULT 60, p_is_open boolean DEFAULT false, p_is_hidden boolean DEFAULT false, p_is_kickbox boolean DEFAULT false, p_custom_slot_price_ils numeric DEFAULT NULL::numeric, p_repeat_mode text DEFAULT 'ongoing'::text, p_fixed_weeks integer DEFAULT NULL::integer, p_copy_roster boolean DEFAULT false, p_athlete_ids uuid[] DEFAULT '{}'::uuid[], p_manual_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_mode public.session_series_repeat_mode;
  v_weeks int;
  v_series_id uuid;
  v_from date;
  v_to date;
  v_roster public.session_series_roster_policy;
  v_first_session uuid;
  v_sid uuid;
  v_ids uuid[] := '{}';
  v_a uuid;
  v_m uuid;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_anchor_date is null or p_coach_id is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_max_participants is null or p_max_participants < 1 then
    return json_build_object('ok', false, 'error', 'invalid_capacity');
  end if;

  v_mode := case lower(trim(coalesce(p_repeat_mode, 'ongoing')))
    when 'fixed_weeks' then 'fixed_weeks'::public.session_series_repeat_mode
    when 'fixed' then 'fixed_weeks'::public.session_series_repeat_mode
    else 'ongoing'::public.session_series_repeat_mode
  end;

  if v_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_weeks := coalesce(p_fixed_weeks, 4);
    if v_weeks < 1 then v_weeks := 1; end if;
    if v_weeks > 52 then v_weeks := 52; end if;
  else
    v_weeks := null;
  end if;

  v_roster := case
    when not coalesce(p_copy_roster, false) then 'none'::public.session_series_roster_policy
    when v_mode = 'ongoing'::public.session_series_repeat_mode then 'copy_on_generate'::public.session_series_roster_policy
    else 'copy_on_create'::public.session_series_roster_policy
  end;

  insert into public.session_series (
    coach_id,
    anchor_date,
    start_time,
    duration_minutes,
    max_participants,
    is_open_for_registration,
    is_hidden,
    is_kickbox,
    custom_slot_price_ils,
    repeat_mode,
    fixed_weeks,
    roster_policy,
    status,
    created_by
  )
  values (
    p_coach_id,
    p_anchor_date,
    p_start_time,
    greatest(1, coalesce(p_duration_minutes, 60)),
    p_max_participants,
    coalesce(p_is_open, false),
    coalesce(p_is_hidden, false),
    coalesce(p_is_kickbox, false),
    p_custom_slot_price_ils,
    v_mode,
    v_weeks,
    v_roster,
    'active',
    v_uid
  )
  returning id into v_series_id;

  v_from := p_anchor_date;
  if v_mode = 'ongoing'::public.session_series_repeat_mode then
    v_to := public._series_horizon_end();
  else
    v_to := p_anchor_date + ((v_weeks - 1) * 7);
  end if;

  perform public._generate_series_occurrences(v_series_id, v_from, v_to);

  select array_agg(t.id order by t.session_date)
  into v_ids
  from public.training_sessions t
  where t.series_id = v_series_id;

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    v_first_session := v_ids[1];

    if v_roster = 'copy_on_create'::public.session_series_roster_policy then
      foreach v_sid in array v_ids loop
        if v_sid is distinct from v_first_session then
          perform public._copy_session_roster(v_first_session, v_sid);
        end if;
      end loop;
    end if;

    if p_athlete_ids is not null then
      foreach v_a in array p_athlete_ids loop
        if v_a is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public.coach_add_athlete(v_sid, v_a, true);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;

    if p_manual_ids is not null then
      foreach v_m in array p_manual_ids loop
        if v_m is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public._series_add_manual_participant_checked(v_sid, v_m);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'series_id', v_series_id,
    'session_ids', coalesce(v_ids, '{}'::uuid[]),
    'count', coalesce(array_length(v_ids, 1), 0)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_update_session_series_scope(p_session_id uuid, p_scope text, p_session_date date, p_start_time time without time zone, p_coach_id uuid, p_max_participants integer, p_duration_minutes integer, p_is_open boolean, p_is_hidden boolean, p_is_kickbox boolean, p_custom_slot_price_ils numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_dur int;
  v_new_date date;
  v_old_date date;
  v_occurrence_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  -- Coaches edit only sessions they coach and never reassign them: a session's pay goes to its coach_id.
  if not public.is_manager(v_uid) then
    if v_sess.coach_id is distinct from v_uid then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    if p_coach_id is not null and p_coach_id is distinct from v_sess.coach_id then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  v_dur := greatest(1, coalesce(p_duration_minutes, 60));
  v_new_date := coalesce(p_session_date, v_sess.session_date);
  v_old_date := v_sess.session_date;

  if v_sess.series_id is null then
    update public.training_sessions
    set
      session_date = v_new_date,
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils
    where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    if v_new_date <> v_old_date then
      if exists (
        select 1 from public.training_sessions t
        where t.series_id = v_sess.series_id
          and t.session_date = v_new_date
          and t.id <> p_session_id
      ) then
        return json_build_object('ok', false, 'error', 'series_date_conflict');
      end if;
    end if;

    -- Forward-only fix: atomically establish or retrieve this occurrence's durable identity,
    -- using PRE-EDIT values, before applying the physical change. Never mutates any OTHER row.
    if v_sess.series_occurrence_id is not null then
      v_occurrence_id := v_sess.series_occurrence_id;
    else
      begin
        insert into public.session_series_occurrences (
          series_id, template_occurrence_date, template_coach_id, template_start_time,
          state, training_session_id
        )
        values (
          v_sess.series_id, v_old_date, v_sess.coach_id, v_sess.start_time, 'edited', p_session_id
        )
        on conflict (series_id, template_occurrence_date) do nothing
        returning id into v_occurrence_id;

        if v_occurrence_id is null then
          -- Identity already claimed (e.g. a concurrent claim for this exact series+date) --
          -- adopt the existing row rather than erroring; the physical edit still proceeds.
          select id into v_occurrence_id
          from public.session_series_occurrences
          where series_id = v_sess.series_id and template_occurrence_date = v_old_date;
        end if;
      exception when unique_violation then
        -- Cross-series logical-slot conflict: a SIBLING series already owns this exact
        -- original (coach,time,date) -- that slot is already protected by that claim. This
        -- occurrence stays unlinked (legacy); the physical edit is not blocked by this.
        v_occurrence_id := null;
      end;
    end if;

    -- Pre-existing skip_dates/series_detached protection, unchanged.
    if v_new_date <> v_old_date then
      update public.session_series
      set skip_dates = (
        select array_agg(distinct d order by d)
        from (
          select unnest(coalesce(skip_dates, '{}'::date[])) as d
          union all
          select v_old_date
        ) u
      )
      where id = v_sess.series_id;
    end if;

    update public.training_sessions
    set
      session_date = v_new_date,
      start_time = coalesce(p_start_time, start_time),
      coach_id = coalesce(p_coach_id, coach_id),
      max_participants = coalesce(p_max_participants, max_participants),
      duration_minutes = v_dur,
      is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
      is_hidden = coalesce(p_is_hidden, is_hidden),
      is_kickbox = coalesce(p_is_kickbox, is_kickbox),
      custom_slot_price_ils = p_custom_slot_price_ils,
      series_detached = true,
      series_occurrence_id = coalesce(v_occurrence_id, v_sess.series_occurrence_id)
    where id = p_session_id;

    if v_occurrence_id is not null then
      update public.session_series_occurrences
      set state = 'edited'
      where id = v_occurrence_id and state <> 'edited';
    end if;

    return json_build_object('ok', true, 'scope', 'this');
  end if;

  -- 'future' scope: unchanged from the prior migration, not part of this pass's scope.
  update public.session_series
  set
    coach_id = coalesce(p_coach_id, coach_id),
    start_time = coalesce(p_start_time, start_time),
    duration_minutes = v_dur,
    max_participants = coalesce(p_max_participants, max_participants),
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils,
    updated_at = now()
  where id = v_sess.series_id;

  update public.training_sessions
  set
    start_time = coalesce(p_start_time, start_time),
    coach_id = coalesce(p_coach_id, coach_id),
    max_participants = coalesce(p_max_participants, max_participants),
    duration_minutes = v_dur,
    is_open_for_registration = coalesce(p_is_open, is_open_for_registration),
    is_hidden = coalesce(p_is_hidden, is_hidden),
    is_kickbox = coalesce(p_is_kickbox, is_kickbox),
    custom_slot_price_ils = p_custom_slot_price_ils
  where series_id = v_sess.series_id
    and session_date >= v_old_date
    and series_detached = false;

  if v_new_date <> v_old_date then
    if exists (
      select 1 from public.training_sessions t
      where t.series_id = v_sess.series_id
        and t.session_date = v_new_date
        and t.id <> p_session_id
    ) then
      return json_build_object('ok', false, 'error', 'series_date_conflict');
    end if;

    update public.session_series
    set skip_dates = (
      select array_agg(distinct d order by d)
      from (
        select unnest(coalesce(skip_dates, '{}'::date[])) as d
        union all
        select v_old_date
      ) u
    )
    where id = v_sess.series_id;

    update public.training_sessions
    set
      session_date = v_new_date,
      series_detached = true
    where id = p_session_id;
  else
    update public.training_sessions
    set series_detached = true
    where id = p_session_id;
  end if;

  return json_build_object('ok', true, 'scope', 'future');
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_move_session_participant(p_from_session_id uuid, p_to_session_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_manual_participant_id uuid DEFAULT NULL::uuid, p_allow_over_capacity boolean DEFAULT false, p_decrease_source_max boolean DEFAULT false, p_increase_dest_max boolean DEFAULT false, p_accept_extra_subscription_charge boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_from public.training_sessions%rowtype;
  v_to public.training_sessions%rowtype;
  v_count int;
  v_count_after int;
  v_reg public.session_registrations%rowtype;
  v_man public.session_manual_participants%rowtype;
  v_linked uuid;
  v_reactivated int;
  v_decision public.subscription_reserve_decision;
  v_dest_reg_id uuid;
  v_source_cov public.subscription_registration_coverage%rowtype;
  v_source_cov_found boolean := false;
  v_from_started boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_from_session_id is null or p_to_session_id is null then
    return json_build_object('ok', false, 'error', 'invalid_session');
  end if;
  if p_from_session_id = p_to_session_id then
    return json_build_object('ok', false, 'error', 'same_session');
  end if;
  if (p_user_id is null) = (p_manual_participant_id is null) then
    return json_build_object('ok', false, 'error', 'invalid_participant');
  end if;

  -- Lock both session rows in a fixed ORDER BY id, independent of which is source/destination,
  -- so two concurrent opposite-direction moves (A->B and B->A) can never deadlock against each
  -- other -- both always attempt to acquire the lower id first.
  if p_from_session_id < p_to_session_id then
    select * into v_from from public.training_sessions where id = p_from_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
    select * into v_to from public.training_sessions where id = p_to_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  else
    select * into v_to from public.training_sessions where id = p_to_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
    select * into v_from from public.training_sessions where id = p_from_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  end if;

  if not public._staff_can_manage_session(v_uid, v_from) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not public._staff_can_manage_session(v_uid, v_to) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- The DESTINATION must still be a session that hasn't started -- unchanged. The SOURCE may have
  -- already started; whether that's allowed is decided per-participant below (payment-recorded
  -- check) instead of being blocked unconditionally here.
  v_from_started := public._session_has_started(v_from);
  if public._session_has_started(v_to) then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;
  if not public._sessions_same_studio_week(v_from.session_date, v_to.session_date) then
    return json_build_object('ok', false, 'error', 'same_week');
  end if;

  if p_user_id is not null then
    -- `for update`: lock this exact row before reading the payment/attendance fields the checks
    -- below rely on, so it serializes against any concurrent payment write on the same row
    -- (attendance RPC, direct table update, or receipt issuance -- see migration header).
    select * into v_reg
    from public.session_registrations
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active'
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_from_started then
      -- Past session: only an actually recorded payment blocks the move (see migration header).
      if coalesce(v_reg.amount_paid, 0) > 0
        or public._payment_has_active_document('session_reg', v_reg.id) then
        return json_build_object('ok', false, 'error', 'payment_recorded');
      end if;
    else
      if v_reg.attended is not null
        or v_reg.payment_method is not null
        or v_reg.amount_paid is not null
        or coalesce(v_reg.charge_no_show, false) then
        return json_build_object('ok', false, 'error', 'roster_locked');
      end if;
    end if;
    if exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = p_user_id and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    if public.athlete_disabled_on_date(p_user_id, v_to.session_date) then
      return json_build_object('ok', false, 'error', 'account_disabled');
    end if;
  else
    -- `for update`: same reasoning as the registered-athlete branch above.
    select * into v_man
    from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_from_started then
      -- Past session: only an actually recorded payment blocks the move (see migration header).
      if coalesce(v_man.amount_paid, 0) > 0
        or public._payment_has_active_document('session_manual', v_man.id) then
        return json_build_object('ok', false, 'error', 'payment_recorded');
      end if;
    else
      if v_man.attended is not null
        or v_man.payment_method is not null
        or v_man.amount_paid is not null
        or coalesce(v_man.charge_no_show, false) then
        return json_build_object('ok', false, 'error', 'roster_locked');
      end if;
    end if;
    if exists (
      select 1 from public.session_manual_participants
      where session_id = p_to_session_id and manual_participant_id = p_manual_participant_id
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    select mp.linked_user_id into v_linked
    from public.manual_participants mp
    where mp.id = p_manual_participant_id;
    if v_linked is not null and exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = v_linked and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
  end if;

  if coalesce(p_increase_dest_max, false) then
    if not public._staff_can_manage_session(v_uid, v_to) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    update public.training_sessions
    set max_participants = max_participants + 1
    where id = p_to_session_id;
    select * into v_to from public.training_sessions where id = p_to_session_id;
  end if;

  v_count := public.active_registration_count(p_to_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_to.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  if coalesce(p_decrease_source_max, false) then
    if not public._staff_can_manage_session(v_uid, v_from) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    if v_from.max_participants <= 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    v_count_after := public.active_registration_count(p_from_session_id) - 1;
    if v_count_after > v_from.max_participants - 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    update public.training_sessions
    set max_participants = max_participants - 1
    where id = p_from_session_id;
  end if;

  -- Subscription entitlement gate for the DESTINATION, evaluated through the exact same
  -- authoritative decision function used by register_for_session/coach_add_athlete/
  -- add_manual_participant_to_session -- no eligibility logic is reimplemented here.
  --
  -- Ordering, found and fixed during testing: the source registration is released FIRST, THEN
  -- the destination is evaluated. Evaluating the destination before releasing the source would
  -- make subscription_reserve_or_reject's count still include the source's own covered=true row
  -- (same subscription/tier/week pool for a same-tier move) and INCORRECTLY reject even the most
  -- common case -- an athlete simply relocating their one already-used allowance slot to a
  -- different day, with no other registrant involved at all. Releasing first works correctly
  -- because of the companion fix in subscription_reserve_or_reject's counting query (see that
  -- function): a cancelled-without-charge row is now excluded from the count, exactly the state
  -- the source is in immediately after being released here.
  --
  -- If the destination is then rejected, the release is explicitly compensated (restored) below
  -- so the net effect is "nothing happened" -- the athlete ends up exactly where they started.
  -- Known, accepted narrow edge case: if some OTHER registration in the same subscription/tier/
  -- week was already sitting uncovered (extra-paid) before this call, the source's release can
  -- cause that other registration's coverage to flip to covered=true via the automatic reconcile
  -- trigger within this same transaction; if the destination is then rejected and the source is
  -- restored, both registrations could transiently show covered=true until the next reconcile
  -- event (e.g. either registration's own attendance being recorded) resolves it via the normal
  -- registered_at-ordered pass. This requires an unusual combination (a pre-existing uncovered
  -- registration in the same pool AND a destination rejection in the same call) and self-heals
  -- the same way the two originally-identified bypasses do; judged an acceptable trade-off
  -- against the complexity of savepoint-based transactional rollback for this narrow case.
  if p_user_id is not null then
    update public.session_registrations
    set status = 'cancelled'
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active';
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    -- The existing subscription_reconcile_on_registration_change trigger (AFTER UPDATE OF
    -- status on session_registrations) fires automatically here and reconciles the SOURCE
    -- week/tier if a coverage row existed for v_reg.id, freeing this slot for any other
    -- existing registration in that subscription/tier/week -- no extra call needed.

    v_decision := public.subscription_reserve_or_reject(
      p_user_id, false, p_to_session_id, coalesce(p_accept_extra_subscription_charge, false)
    );
    if not v_decision.ok then
      -- Compensate: restore the source exactly as it was. Only status was ever touched here --
      -- attended/payment_method/amount_paid/charge_no_show/payment_recorded_by/at were never
      -- modified by this function (and, for a not-yet-started source, were already confirmed
      -- null/false by the roster_locked check above), so a plain status flip back is exact.
      update public.session_registrations
      set status = 'active'
      where session_id = p_from_session_id and user_id = p_user_id;
      return json_build_object(
        'ok', false,
        'error', 'subscription_limit_exceeded',
        'reason', v_decision.non_coverage_reason::text
      );
    end if;

    insert into public.registration_history (session_id, user_id, event_type)
    values (p_from_session_id, p_user_id, 'removed');

    -- Registration-order priority choice (documented per the audit): the destination row
    -- preserves the ORIGINAL registration's registered_at (v_reg.registered_at, captured above
    -- before cancellation) instead of resetting to now(). A staff-initiated move relocates an
    -- existing commitment rather than creating a new voluntary registration act. For a same-tier
    -- move (the common case, capacity unchanged) this is not just a style choice but the
    -- technically correct one: the athlete already held a claim on that subscription/tier/week's
    -- shared allowance pool from the original registration time, and moving to a different day
    -- within the same week/tier doesn't create a new claim on a different pool. For the rarer
    -- cross-tier move, preserving the original timestamp could in theory let the athlete
    -- outrank another registrant who joined the destination tier's pool between the original
    -- registration and the move -- judged an acceptable, narrow trade-off for a staff-
    -- administrative action versus the complexity of a tier-aware priority rule.
    update public.session_registrations
    set
      status = 'active',
      registered_at = v_reg.registered_at,
      attended = null,
      payment_method = null,
      amount_paid = null,
      charge_no_show = false,
      payment_recorded_by = null,
      payment_recorded_at = null
    where session_id = p_to_session_id and user_id = p_user_id and status = 'cancelled'
    returning id into v_dest_reg_id;
    get diagnostics v_reactivated = row_count;

    if v_reactivated = 0 then
      insert into public.session_registrations (session_id, user_id, status, registered_at)
      values (p_to_session_id, p_user_id, 'active', v_reg.registered_at)
      returning id into v_dest_reg_id;
    end if;

    insert into public.registration_history (session_id, user_id, event_type)
    values (p_to_session_id, p_user_id, 'registered');

    delete from public.waitlist_requests
    where session_id = p_to_session_id and user_id = p_user_id;

    if v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, v_dest_reg_id, null,
        v_to.session_date, v_decision.week_start, v_decision.tier,
        v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
      )
      on conflict (registration_id) where registration_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'registration';
    end if;
  else
    -- Capture the source coverage row (if any) before deleting it -- needed both to reconcile the
    -- freed slot on success and to restore it exactly on a compensating rollback. Removing a
    -- manual participant is a hard DELETE (unlike the app-athlete case's status flip), so no
    -- UPDATE-based trigger fires for it automatically; the coverage row cascade-deletes with it.
    select * into v_source_cov
    from public.subscription_registration_coverage
    where manual_participant_id = v_man.id;
    v_source_cov_found := found;

    delete from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id;
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;

    -- Same released-before-decided ordering as the app-athlete branch above, for the same
    -- reason: the deleted row's coverage no longer exists to be (mis)counted, so a same-tier
    -- move of an at-capacity manual participant is correctly evaluated as having room.
    v_decision := public.subscription_reserve_or_reject(
      p_manual_participant_id, true, p_to_session_id, coalesce(p_accept_extra_subscription_charge, false)
    );
    if not v_decision.ok then
      -- Compensate: re-insert the participant on the source exactly as before -- including
      -- attended/payment_method/amount_paid/charge_no_show/payment_recorded_by/payment_recorded_at,
      -- captured on v_man before the delete above (fixed here: previously these columns were
      -- dropped on this path, which was harmless only while roster_locked guaranteed they were
      -- already null/false for every move that could reach this point; a past, unpaid-but-
      -- attended/no-show-flagged move can reach it now, so they must be restored explicitly to
      -- avoid silently discarding that historical data on a subscription rejection-and-restore)
      -- -- and restore its coverage row's prior decision, since the DELETE cascaded it away.
      insert into public.session_manual_participants (
        session_id, manual_participant_id, added_at,
        attended, payment_method, amount_paid, charge_no_show,
        payment_recorded_by, payment_recorded_at
      )
      values (
        p_from_session_id, p_manual_participant_id, v_man.added_at,
        v_man.attended, v_man.payment_method, v_man.amount_paid, v_man.charge_no_show,
        v_man.payment_recorded_by, v_man.payment_recorded_at
      );
      if v_source_cov_found then
        insert into public.subscription_registration_coverage(
          subscription_id, version_id, registration_id, manual_participant_id,
          session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
        )
        select
          v_source_cov.subscription_id, v_source_cov.version_id, null, sm.id,
          v_source_cov.session_date, v_source_cov.week_start, v_source_cov.tier,
          v_source_cov.covered, v_source_cov.non_coverage_reason, v_source_cov.decided_at, v_source_cov.decided_by
        from public.session_manual_participants sm
        where sm.session_id = p_from_session_id and sm.manual_participant_id = p_manual_participant_id;
      end if;
      return json_build_object(
        'ok', false,
        'error', 'subscription_limit_exceeded',
        'reason', v_decision.non_coverage_reason::text
      );
    end if;

    -- Only now (destination confirmed) reconcile the freed source slot for any other existing
    -- registration in that subscription/tier/week -- deferred here (unlike the app-athlete
    -- branch, where it fires unavoidably via the UPDATE trigger the moment the source changes)
    -- specifically so a subsequent rejection-and-restore never has to unwind a reconcile that
    -- already ran.
    if v_source_cov_found then
      perform public.subscription_reconcile_week(
        v_source_cov.subscription_id, v_source_cov.week_start, v_source_cov.tier
      );
    end if;

    insert into public.session_manual_participants (session_id, manual_participant_id, added_at)
    values (p_to_session_id, p_manual_participant_id, v_man.added_at)
    returning id into v_dest_reg_id;

    if v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, null, v_dest_reg_id,
        v_to.session_date, v_decision.week_start, v_decision.tier,
        v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'registration';
    end if;
  end if;

  perform public._insert_activity_event(
    v_uid,
    'participant_moved',
    'session',
    p_to_session_id::text,
    jsonb_build_object(
      'from_session_id', p_from_session_id,
      'to_session_id', p_to_session_id,
      'user_id', p_user_id,
      'manual_participant_id', p_manual_participant_id
    )
  );

  return json_build_object('ok', true);
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'already_in_session');
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_set_session_custom_slot_price(p_session_id uuid, p_price_ils numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_price_ils is not null and p_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid and exists (
    select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach'
  ) then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.training_sessions
  set custom_slot_price_ils = case when p_price_ils is null then null else round(p_price_ils::numeric, 2) end
  where id = p_session_id;

  return json_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_set_session_roster_slot_price(p_session_id uuid, p_user_id uuid, p_manual_participant_id uuid, p_price_ils numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if (p_user_id is null) = (p_manual_participant_id is null) then
    return json_build_object('ok', false, 'error', 'invalid_payee');
  end if;

  if p_price_ils is not null and p_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid and exists (
    select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach'
  ) then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_user_id is not null then
    if not exists (
      select 1 from public.session_registrations r
      where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'not_on_roster');
    end if;
  else
    if not exists (
      select 1 from public.session_manual_participants m
      where m.session_id = p_session_id and m.manual_participant_id = p_manual_participant_id
    ) then
      return json_build_object('ok', false, 'error', 'not_on_roster');
    end if;
  end if;

  if p_price_ils is null then
    delete from public.session_roster_slot_prices
    where session_id = p_session_id
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_manual_participant_id is not null and manual_participant_id = p_manual_participant_id)
      );
    return json_build_object('ok', true);
  end if;

  if p_user_id is not null then
    update public.session_roster_slot_prices
    set price_ils = round(p_price_ils::numeric, 2), updated_at = now()
    where session_id = p_session_id and user_id = p_user_id;
    if not found then
      insert into public.session_roster_slot_prices (session_id, user_id, price_ils)
      values (p_session_id, p_user_id, round(p_price_ils::numeric, 2));
    end if;
  else
    update public.session_roster_slot_prices
    set price_ils = round(p_price_ils::numeric, 2), updated_at = now()
    where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
    if not found then
      insert into public.session_roster_slot_prices (session_id, manual_participant_id, price_ils)
      values (p_session_id, p_manual_participant_id, round(p_price_ils::numeric, 2));
    end if;
  end if;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

CREATE OR REPLACE FUNCTION public._coach_add_athlete_core(p_session_id uuid, p_user_id uuid, p_allow_over_capacity boolean, p_accept_extra_subscription_charge boolean, p_actor uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sess public.training_sessions%rowtype;
  v_count int;
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id for update;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if p_actor is not null then
    if public.is_manager(p_actor) then
      null;
    elsif v_sess.coach_id = p_actor and exists (select 1 from public.profiles p where p.user_id = p_actor and p.role = 'coach') then
      null;
    else
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  if v_sess.coach_id = p_user_id then
    return json_build_object('ok', false, 'error', 'is_session_coach');
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = p_user_id and approval_status = 'approved' and role in ('athlete', 'coach')
  ) then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;

  if public.athlete_disabled_on_date(p_user_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  v_decision := public.subscription_reserve_or_reject(
    p_user_id, false, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  insert into public.session_registrations (session_id, user_id, status)
  values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update
    set status = 'active', registered_at = now()
  returning id into v_reg_id;

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'registered');

  delete from public.waitlist_requests where session_id = p_session_id and user_id = p_user_id;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
    )
    on conflict (registration_id) where registration_id is not null do update set
      subscription_id = excluded.subscription_id,
      version_id = excluded.version_id,
      session_date = excluded.session_date,
      week_start = excluded.week_start,
      tier = excluded.tier,
      covered = excluded.covered,
      non_coverage_reason = excluded.non_coverage_reason,
      decided_at = now(),
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_manual_participant_to_session(p_session_id uuid, p_manual_participant_id uuid, p_allow_over_capacity boolean DEFAULT false, p_accept_extra_subscription_charge boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_count int;
  v_n int;
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id for update;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.manual_participant_disabled_on_date(p_manual_participant_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  v_decision := public.subscription_reserve_or_reject(
    p_manual_participant_id, true, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  insert into public.session_manual_participants (session_id, manual_participant_id)
  values (p_session_id, p_manual_participant_id)
  on conflict (session_id, manual_participant_id) do nothing
  returning id into v_reg_id;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'already_in_session');
  end if;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, null, v_reg_id,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
    )
    on conflict (manual_participant_id) where manual_participant_id is not null do update set
      subscription_id = excluded.subscription_id,
      version_id = excluded.version_id,
      session_date = excluded.session_date,
      week_start = excluded.week_start,
      tier = excluded.tier,
      covered = excluded.covered,
      non_coverage_reason = excluded.non_coverage_reason,
      decided_at = now(),
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.maintain_session_series_horizon()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  return public._maintain_session_series_horizon_core();
end;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_series_duplicate_sessions()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_deleted int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_deleted := public._reconcile_slot_duplicate_sessions();
  return json_build_object('ok', true, 'deleted_empty', v_deleted);
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_session_note(p_note_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_note public.session_notes%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_note from public.session_notes where id = p_note_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  if not (public.is_manager(v_uid) or v_note.author_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  delete from public.session_notes where id = p_note_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end;
$function$;

drop policy if exists session_series_manager_insert on public.session_series;
drop policy if exists session_series_manager_update on public.session_series;
drop policy if exists session_series_manager_delete on public.session_series;
create policy session_series_staff_write on public.session_series
  for all using (public.is_coach_or_manager(auth.uid())) with check (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_roster_slot_prices_manager_write on public.session_roster_slot_prices;
create policy session_roster_slot_prices_manager_or_session_coach_write on public.session_roster_slot_prices
  for all
  using (public.is_manager(auth.uid()) or exists (select 1 from public.training_sessions s where s.id = session_roster_slot_prices.session_id and s.coach_id = auth.uid()))
  with check (public.is_manager(auth.uid()) or exists (select 1 from public.training_sessions s where s.id = session_roster_slot_prices.session_id and s.coach_id = auth.uid()));

drop policy if exists session_notes_update_author_or_manager on public.session_notes;
create policy session_notes_update_author_or_manager on public.session_notes
  for update
  using (public.is_coach_or_manager(auth.uid()) and (public.is_manager(auth.uid()) or author_id = auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()) and (public.is_manager(auth.uid()) or author_id = auth.uid())
              and body is not null and length(trim(both from body)) >= 1);
drop policy if exists session_notes_delete_author_or_manager on public.session_notes;
create policy session_notes_delete_author_or_manager on public.session_notes
  for delete using (public.is_manager(auth.uid()) or author_id = auth.uid());

drop policy if exists session_manual_participants_update_manager on public.session_manual_participants;
create policy session_manual_participants_update_staff on public.session_manual_participants
  for update
  using (public.is_manager(auth.uid()) or (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach'::public.user_role)
    and exists (select 1 from public.training_sessions s where s.id = session_manual_participants.session_id and s.coach_id = auth.uid())))
  with check (public.is_manager(auth.uid()) or (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach'::public.user_role)
    and exists (select 1 from public.training_sessions s where s.id = session_manual_participants.session_id and s.coach_id = auth.uid())));

grant execute on function public.staff_delete_session_series_scope(uuid, text) to public, anon;
grant execute on function public.staff_create_session_series(date, time without time zone, uuid, integer, integer, boolean, boolean, boolean, numeric, text, integer, boolean, uuid[], uuid[]) to public, anon;
grant execute on function public.staff_update_session_series_scope(uuid, text, date, time without time zone, uuid, integer, integer, boolean, boolean, boolean, numeric) to public, anon;
grant execute on function public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean) to public, anon;
grant execute on function public.staff_set_session_custom_slot_price(uuid, numeric) to public, anon;
grant execute on function public.staff_set_session_roster_slot_price(uuid, uuid, uuid, numeric) to public, anon;
grant execute on function public.coach_add_athlete(uuid, uuid, boolean, boolean) to public, anon;
grant execute on function public.add_manual_participant_to_session(uuid, uuid, boolean, boolean) to public, anon;
grant execute on function public.maintain_session_series_horizon() to public, anon;
grant execute on function public.reconcile_series_duplicate_sessions() to public, anon;
grant execute on function public.delete_session_note(uuid) to public, anon;
grant truncate on table public.training_sessions, public.session_series, public.session_roster_slot_prices,
  public.session_manual_participants, public.session_registrations, public.session_notes, public.waitlist_requests
  to anon, authenticated;
