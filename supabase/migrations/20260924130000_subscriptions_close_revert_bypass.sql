-- Subscription Management — close bypass #3: manager_revert_activity_event.
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md.
--
-- Full audit of every case in manager_revert_activity_event (supabase/migrations/
-- 20260628201000_activity_log_revert_extended.sql, the current latest definition) for anything
-- that can transition session_registrations/session_manual_participants into an active/
-- chargeable state:
--   - 'session_registration_cancelled' undo -> calls public.coach_add_athlete: already gated.
--   - 'session_manual_participant_removed' undo -> calls public.add_manual_participant_to_session:
--     already gated.
--   - 'session_registration' undo, 'session_manual_participant_added' undo -> remove/delete a
--     participant; never creates a confirmed registration.
--   - 'registration_attendance_updated' / 'manual_participant_attendance_updated' undo -> raw
--     UPDATE of attended/payment/charge_no_show only, never touches `status`; already fires the
--     existing subscription_reconcile_on_registration_change /
--     subscription_reconcile_on_manual_participant_change triggers.
--   - 'cancellation_charge_updated' undo -> raw UPDATE of cancellations.charged_full_price;
--     already fires the existing subscription_reconcile_on_cancellation_change trigger.
--   - 'session_registration_status_changed' undo -> the one case that writes `status` directly.
--     Given the trigger that produces this event type (public.tg_session_registrations_activity,
--     20260410120000_user_activity_log.sql) routes every transition ending in 'cancelled' to the
--     dedicated 'session_registration_cancelled' event type instead, and
--     public.registration_status has exactly two values ('active'/'cancelled', confirmed never
--     altered), this event's metadata->>'from' is currently always 'cancelled' — meaning today's
--     code can only ever revert active->cancelled, never restore into active/chargeable state, so
--     this specific path was not actually reachable as a live bypass under the current trigger
--     logic. It is fixed here as defense-in-depth regardless (per the explicit decision to close
--     it, and because it costs nothing and protects against any future change to the trigger's
--     logic, the enum, or a differently-sourced event with the same event_type): whenever this
--     case WOULD set status to 'active' from a non-active state, it now goes through the exact
--     same subscription_reserve_or_reject gate as every other confirmed-registration path, with
--     the same undo-is-not-consent structured-warning contract. Any other direction (i.e. today's
--     only reachable case, reverting back to 'cancelled') is unchanged, raw-update behavior.
--
-- Full original body preserved verbatim from 20260628201000_activity_log_revert_extended.sql,
-- with (a) a new trailing p_accept_extra_subscription_charge param and (b) the
-- 'session_registration_status_changed' case rewritten as described above. No other case changed.

create or replace function public.manager_revert_activity_event(
  p_event_id uuid,
  p_accept_extra_subscription_charge boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.user_activity_events%rowtype;
  info json;
  v_changes jsonb;
  v_sid uuid;
  v_uid uuid;
  v_manual_id uuid;
  v_reg_id uuid;
  v_res json;
  v_prev public.approval_status;
  v_from_status public.registration_status;
  v_row public.session_registrations%rowtype;
  v_decision public.subscription_reserve_decision;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  info := public.manager_activity_revert_info(p_event_id);
  if coalesce((info->>'ok')::boolean, false) is not true then
    return info;
  end if;
  if coalesce((info->>'can_revert')::boolean, false) is not true then
    return json_build_object('ok', false, 'error', coalesce(info->>'reason', 'not_revertible'));
  end if;

  select * into ev from public.user_activity_events where id = p_event_id for update;
  if ev.reverted_at is not null then
    return json_build_object('ok', false, 'error', 'already_reverted');
  end if;

  v_changes := coalesce(ev.metadata->'changes', '{}'::jsonb);
  perform set_config('shira.skip_activity_log', 'on', true);

  case ev.event_type
    when 'profile_updated' then
      update public.profiles p
      set
        full_name = case when v_changes ? 'full_name' then v_changes->'full_name'->>'from' else p.full_name end,
        phone = case when v_changes ? 'phone' then v_changes->'phone'->>'from' else p.phone end,
        gender = case when v_changes ? 'gender' then v_changes->'gender'->>'from' else p.gender end,
        date_of_birth = case
          when v_changes ? 'date_of_birth' and nullif(v_changes->'date_of_birth'->>'from', '') is not null
            then (v_changes->'date_of_birth'->>'from')::date
          when v_changes ? 'date_of_birth' then null
          else p.date_of_birth
        end,
        username = case when v_changes ? 'username' then v_changes->'username'->>'from' else p.username end
      where p.user_id = ev.target_id::uuid;

    when 'athlete_approved', 'athlete_rejected', 'athlete_approval_updated' then
      v_prev := (ev.metadata->>'previous_approval_status')::public.approval_status;
      update public.profiles
      set approval_status = v_prev
      where user_id = ev.target_id::uuid and role = 'athlete';

    when 'session_updated' then
      update public.training_sessions s
      set
        session_date = case when v_changes ? 'session_date' then (v_changes->'session_date'->>'from')::date else s.session_date end,
        start_time = case when v_changes ? 'start_time' then (v_changes->'start_time'->>'from')::time else s.start_time end,
        coach_id = case when v_changes ? 'coach_id' then (v_changes->'coach_id'->>'from')::uuid else s.coach_id end,
        max_participants = case when v_changes ? 'max_participants' then (v_changes->'max_participants'->>'from')::int else s.max_participants end,
        is_open_for_registration = case when v_changes ? 'is_open_for_registration' then (v_changes->'is_open_for_registration'->>'from')::boolean else s.is_open_for_registration end,
        duration_minutes = case when v_changes ? 'duration_minutes' then (v_changes->'duration_minutes'->>'from')::int else s.duration_minutes end,
        is_hidden = case when v_changes ? 'is_hidden' then (v_changes->'is_hidden'->>'from')::boolean else s.is_hidden end,
        custom_slot_price_ils = case
          when v_changes ? 'custom_slot_price_ils' and v_changes->'custom_slot_price_ils'->'from' = 'null'::jsonb then null
          when v_changes ? 'custom_slot_price_ils' then (v_changes->'custom_slot_price_ils'->>'from')::numeric
          else s.custom_slot_price_ils
        end
      where s.id = ev.target_id::uuid;

    when 'session_created' then
      delete from public.training_sessions where id = ev.target_id::uuid;

    when 'session_registration' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.manager_remove_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'remove_failed'));
      end if;

    when 'session_registration_cancelled' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.coach_add_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'session_registration_status_changed' then
      v_reg_id := ev.target_id::uuid;
      v_from_status := (ev.metadata->>'from')::public.registration_status;

      select * into v_row from public.session_registrations where id = v_reg_id;
      if not found then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', 'registration_missing');
      end if;

      if v_from_status = 'active'::public.registration_status
        and v_row.status is distinct from 'active'::public.registration_status
      then
        -- Restoring into active/chargeable state: authoritative entitlement decision, same
        -- function as every other confirmed-registration path. Undo is not consent — a
        -- non-covered outcome without explicit p_accept_extra_subscription_charge must reject
        -- with the same structured warning, leaving the cancelled state fully intact.
        v_decision := public.subscription_reserve_or_reject(
          v_row.user_id, false, v_row.session_id, coalesce(p_accept_extra_subscription_charge, false)
        );
        if not v_decision.ok then
          perform set_config('shira.skip_activity_log', 'off', true);
          return json_build_object(
            'ok', false,
            'error', 'subscription_limit_exceeded',
            'reason', v_decision.non_coverage_reason::text
          );
        end if;

        update public.session_registrations
        set status = 'active'
        where id = v_reg_id;

        if v_decision.outcome <> 'not_subscribed' then
          insert into public.subscription_registration_coverage(
            subscription_id, version_id, registration_id, manual_participant_id,
            session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
          )
          values (
            v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
            (select session_date from public.training_sessions where id = v_row.session_id),
            v_decision.week_start, v_decision.tier,
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
        -- Not a transition into active/chargeable state (the only case reachable under the
        -- current event-producing trigger: reverting active->cancelled back to cancelled) —
        -- unchanged, raw-update behavior.
        update public.session_registrations
        set status = v_from_status
        where id = v_reg_id;
      end if;

    when 'session_manual_participant_added' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      delete from public.session_manual_participants
      where session_id = v_sid and manual_participant_id = v_manual_id;

    when 'session_manual_participant_removed' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      v_res := public.add_manual_participant_to_session(v_sid, v_manual_id);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'registration_attendance_updated' then
      update public.session_registrations r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'manual_participant_attendance_updated' then
      update public.session_manual_participants r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'user_role_changed' then
      update public.profiles
      set role = (ev.metadata->>'previous_role')::public.user_role
      where user_id = ev.target_id::uuid;

    when 'cancellation_charge_updated' then
      update public.cancellations
      set
        charged_full_price = coalesce(public._activity_jsonb_to_boolean(v_changes->'charged_full_price'->'from'), false),
        penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'cancellation_penalty_collected_updated' then
      update public.cancellations
      set penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'registration_opening_schedule_updated' then
      update public.app_settings
      set
        registration_open_weekday = (v_changes->'registration_open_weekday'->>'from')::int,
        registration_open_time = (v_changes->'registration_open_time'->>'from')::time,
        updated_at = now()
      where id = 1;

    when 'session_note_created' then
      delete from public.session_notes where id = ev.target_id::uuid;

    when 'session_note_deleted' then
      insert into public.session_notes (id, session_id, author_id, body)
      values (
        ev.target_id::uuid,
        (ev.metadata->>'session_id')::uuid,
        (ev.metadata->>'author_id')::uuid,
        ev.metadata->>'body'
      );

    else
      perform set_config('shira.skip_activity_log', 'off', true);
      return json_build_object('ok', false, 'error', 'not_revertible');
  end case;

  update public.user_activity_events
  set reverted_at = now(), reverted_by = auth.uid()
  where id = p_event_id;

  perform set_config('shira.skip_activity_log', 'off', true);

  perform public._insert_activity_event(
    auth.uid(),
    'activity_event_reverted',
    'user_activity_event',
    p_event_id::text,
    jsonb_build_object('reverted_event_type', ev.event_type)
  );

  return json_build_object('ok', true);
exception
  when others then
    perform set_config('shira.skip_activity_log', 'off', true);
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.manager_revert_activity_event(uuid, boolean) to authenticated;
