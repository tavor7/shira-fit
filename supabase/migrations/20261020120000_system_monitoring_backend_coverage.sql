-- System Issues monitoring completion, item 1: backend coverage completion.
--
-- Three documented silent-failure sites are forwarded to System Issues via the existing trusted
-- ingestion path (_report_system_error, unchanged signature from 20261006120000). None of these
-- changes alter business behavior: every site already swallows the failure (continues normally);
-- this migration only adds a best-effort report alongside the existing swallow/discard.
--
-- Transaction-safety audit (each site is durable exactly when the surrounding transaction commits,
-- same accepted limitation already documented in 20261006120000's header - no autonomous-transaction
-- or dblink machinery is introduced):
--   1. _copy_session_roster's two per-row loops: the report call runs inside the existing
--      `exception when others then null` handler, after the failed sub-block's implicit savepoint
--      rollback. Nothing in the function runs after a given iteration that could abort the whole
--      transaction because of this iteration - safe.
--   2. staff_create_session_series's two per-row loops: same shape, same conclusion.
--   3. Fingerprints are scoped to the operation (series id / session pair), not to the individual
--      athlete/participant id, so N failing rows in one call collapse into one issue with an
--      incrementing occurrence_count rather than N separate issues (consistent with the flood
--      control already built into _system_ingest_impl).
--
-- IMPORTANT, discovered during implementation and testing (see suite 182 and the release report):
-- this closes coverage for genuine unexpected exceptions only - exactly what `exception when
-- others then null` already existed to catch. It does NOT close a separate, deeper gap: the
-- functions these loops call (_coach_add_athlete_core, coach_add_athlete,
-- _series_add_manual_participant_checked) each already catch their OWN expected business outcomes
-- (session_not_found, invalid_athlete, full, subscription_limit_exceeded, non-coverage, ...) and
-- RETURN {ok:false,...} rather than raising - these call sites invoke them with a bare `perform`,
-- discarding that return value, both before and after this migration. A discarded {ok:false} is
-- not an exception, so neither the pre-existing handler nor this migration's addition to it ever
-- sees it. In practice this means the manual-participant loop's added report is effectively unused
-- today (_series_add_manual_participant_checked swallows internally unconditionally), and the
-- athlete loop's added report only fires for the rarer true-exception case, not for the more common
-- "athlete is not eligible / session is full / not covered" outcomes. Closing that deeper gap would
-- mean capturing and inspecting each call's own return value - a larger, more deliberate change to
-- code that also drives financial subscription-coverage decisions - and is deferred rather than
-- attempted here, consistent with "avoid unnecessary architectural rewrites" and "do not change
-- financial business logic".

create or replace function public._copy_session_roster(p_from_session uuid, p_to_session uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  m record;
  -- No authenticated caller means a server-side run (pg_cron horizon maintenance). Authorization for
  -- the copy was given when the creator stored the series' roster_policy.
  v_trusted boolean := auth.uid() is null;
begin
  if p_from_session is null or p_to_session is null or p_from_session = p_to_session then
    return;
  end if;

  for r in
    select user_id
    from public.session_registrations
    where session_id = p_from_session and status = 'active'
  loop
    begin
      if v_trusted then
        perform public._coach_add_athlete_core(p_to_session, r.user_id, true, false, null);
      else
        perform public.coach_add_athlete(p_to_session, r.user_id, true);
      end if;
    exception when others then
      perform public._report_system_error(
        p_source := 'trusted',
        p_subsystem := 'session_series',
        p_operation := 'copy_session_roster_athlete',
        p_error_class := 'swallowed_exception',
        p_message := 'Failed to copy an athlete registration onto a newly generated series session.',
        p_severity := 'warning',
        p_entities := jsonb_build_object('from_session', p_from_session, 'to_session', p_to_session),
        p_fingerprint_key := 'session_roster_copy_athlete_failed:' || p_from_session || ':' || p_to_session);
    end;
  end loop;

  for m in
    select manual_participant_id
    from public.session_manual_participants
    where session_id = p_from_session
  loop
    begin
      perform public._series_add_manual_participant_checked(p_to_session, m.manual_participant_id);
    exception when others then
      perform public._report_system_error(
        p_source := 'trusted',
        p_subsystem := 'session_series',
        p_operation := 'copy_session_roster_manual',
        p_error_class := 'swallowed_exception',
        p_message := 'Failed to copy a manual participant onto a newly generated series session.',
        p_severity := 'warning',
        p_entities := jsonb_build_object('from_session', p_from_session, 'to_session', p_to_session),
        p_fingerprint_key := 'session_roster_copy_manual_failed:' || p_from_session || ':' || p_to_session);
    end;
  end loop;
end;
$function$;

-- IMPORTANT correction made during implementation/testing (see the release report): an earlier
-- draft of this migration reconstructed this function from memory instead of copying it verbatim
-- from 20261020100000, and introduced material, unintended differences (wrong table name, wrong
-- manager-check query, missing p_anchor_date/p_coach_id/p_max_participants validation, different
-- repeat-mode parsing). That draft was caught by the mobile Jest registry-completeness test
-- flagging invalid_capacity/invalid_input as stale (no longer returned) and was never applied to
-- any shared branch. The body below is the real, unmodified 20261020100000 definition with only
-- the two exception handlers changed, verified line-by-line against that file before writing this.
create or replace function public.staff_create_session_series(p_anchor_date date, p_start_time time without time zone, p_coach_id uuid, p_max_participants integer, p_duration_minutes integer DEFAULT 60, p_is_open boolean DEFAULT false, p_is_hidden boolean DEFAULT false, p_is_kickbox boolean DEFAULT false, p_custom_slot_price_ils numeric DEFAULT NULL::numeric, p_repeat_mode text DEFAULT 'ongoing'::text, p_fixed_weeks integer DEFAULT NULL::integer, p_copy_roster boolean DEFAULT false, p_athlete_ids uuid[] DEFAULT '{}'::uuid[], p_manual_ids uuid[] DEFAULT '{}'::uuid[])
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
  -- Coach session permissions (owner policy 2026-10-15): session configuration is manager-only.
  if not public.is_manager(v_uid) then
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
            perform public._report_system_error(
              p_source := 'trusted',
              p_subsystem := 'session_series',
              p_operation := 'series_create_add_athlete',
              p_error_class := 'swallowed_exception',
              p_message := 'Failed to add a requested athlete to a newly created series session.',
              p_severity := 'warning',
              p_entities := jsonb_build_object('series_id', v_series_id),
              p_fingerprint_key := 'series_create_add_athlete_failed:' || v_series_id);
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
            perform public._report_system_error(
              p_source := 'trusted',
              p_subsystem := 'session_series',
              p_operation := 'series_create_add_manual',
              p_error_class := 'swallowed_exception',
              p_message := 'Failed to add a requested manual participant to a newly created series session.',
              p_severity := 'warning',
              p_entities := jsonb_build_object('series_id', v_series_id),
              p_fingerprint_key := 'series_create_add_manual_failed:' || v_series_id);
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

-- Subscription billing-period correction, cron-job path: generate_due_subscription_charges() (from
-- 20261005150000) already reports hard exceptions to Activity Log, but silently discards the case
-- where subscription_generate_or_correct_billing_period() returns {ok:false,...} WITHOUT raising -
-- the loop just skips the period, with no record anywhere that a subscription failed to be billed.
-- This is exactly the "cron job returns success while internal business operation fails" pattern the
-- monitoring completion brief calls out explicitly. Function body is otherwise byte-for-byte
-- unchanged from 20261005150000 (verified by direct comparison before editing) - billing logic,
-- ordering and retry behaviour are unchanged; this migration only adds reporting.
--
-- Scope note: subscription_generate_or_correct_billing_period is also called from four other,
-- interactive call sites (subscription create/edit/freeze/stop/reactivate, spread across several
-- large financially-sensitive functions in earlier migrations). Those are deliberately NOT touched
-- here: a manager already receives an immediate {ok:false} response synchronously in the UI for
-- those paths (the gap is far lower severity than the unattended cron job), and safely reproducing
-- each of those large function bodies verbatim purely to add a report call carries transcription
-- risk disproportionate to the benefit, which would cut against "do not change financial business
-- logic" and "avoid unnecessary architectural rewrites". Flagged as a follow-up in the release report.
--
-- Transaction-safety: the report call sits inside the same per-subscription sub-block that already
-- isolates each subscription's failure from the others (`begin ... exception when others`), so it is
-- durable exactly when that isolation already is - no new risk introduced.
create or replace function public.generate_due_subscription_charges()
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := public._studio_today_date();
  r record;
  v_last_raw_start date;
  v_next_raw_start date;
  v_next_raw_end date;
  v_effective_start date;
  v_effective_plan_end date;
  v_periods_touched int := 0;
  v_failed int := 0;
  v_res json;
  v_stranded_id uuid;
  v_stranded_version uuid;
  v_stranded_raw_start date;
  v_stranded_raw_end date;
  v_err_state text;
  v_err_msg text;
begin
  for r in
    select s.id as subscription_id, v.id as version_id, v.anchor_day, v.plan_start_date,
           v.stopped_effective_date, v.plan_end_date
    from public.subscriptions s
    join public.subscription_versions v
      on v.subscription_id = s.id and v.effective_to is null
    where s.deleted_at is null
      and v.plan_start_date <= v_today
  loop
    begin
      v_effective_plan_end := public.subscription_effective_plan_end_date(r.version_id);
      loop
        select bp.id, bp.version_id, bp.raw_period_start, bp.raw_period_end
        into v_stranded_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
          and not exists (
            select 1 from public.subscription_charges c
            where c.billing_period_id = bp.id and c.charge_type in ('recurring', 'proration')
          )
        order by bp.raw_period_start asc
        limit 1;

        if v_stranded_id is not null then
          v_res := public.subscription_generate_or_correct_billing_period(
            r.subscription_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end, null, null
          );
          if coalesce((v_res->>'ok')::boolean, false) then
            v_periods_touched := v_periods_touched + 1;
          else
            perform public._report_system_error(
              p_source := 'trusted',
              p_subsystem := 'subscriptions',
              p_operation := 'billing_period_correction',
              p_error_class := 'ok_false',
              p_message := coalesce(v_res->>'error', 'subscription_generate_or_correct_billing_period returned ok:false'),
              p_severity := 'error',
              p_entities := jsonb_build_object('subscription_id', r.subscription_id, 'billing_period_id', v_stranded_id),
              p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
          end if;
          continue;
        end if;

        select bp.raw_period_start into v_last_raw_start
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
        order by bp.raw_period_start desc
        limit 1;

        if v_last_raw_start is null then
          v_next_raw_start := r.plan_start_date;
        else
          v_next_raw_start := public.subscription_next_anchor_date(r.anchor_day, v_last_raw_start);
        end if;

        v_next_raw_end := public.subscription_next_anchor_date(r.anchor_day, v_next_raw_start);
        v_effective_start := v_next_raw_start + public.subscription_total_frozen_days(r.subscription_id, v_next_raw_end);

        exit when v_effective_start > v_today;
        exit when r.stopped_effective_date is not null and v_effective_start >= r.stopped_effective_date;
        exit when v_effective_plan_end is not null and v_effective_start > v_effective_plan_end;

        v_res := public.subscription_generate_or_correct_billing_period(
          r.subscription_id, r.version_id, v_next_raw_start, v_next_raw_end, null, null
        );
        if coalesce((v_res->>'ok')::boolean, false) then
          v_periods_touched := v_periods_touched + 1;
        else
          perform public._report_system_error(
            p_source := 'trusted',
            p_subsystem := 'subscriptions',
            p_operation := 'billing_period_correction',
            p_error_class := 'ok_false',
            p_message := coalesce(v_res->>'error', 'subscription_generate_or_correct_billing_period returned ok:false'),
            p_severity := 'error',
            p_entities := jsonb_build_object('subscription_id', r.subscription_id),
            p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
        end if;
      end loop;
    exception
      when others then
        v_failed := v_failed + 1;
        get stacked diagnostics v_err_state = returned_sqlstate, v_err_msg = message_text;
        begin
          perform public._insert_activity_event(
            null, 'subscription_billing_failed', 'subscription', r.subscription_id::text,
            jsonb_build_object('sqlstate', v_err_state, 'error', left(v_err_msg, 500), 'run_date', v_today)
          );
        exception when others then
          null;
        end;
        perform public._report_system_error(
          p_source := 'trusted',
          p_subsystem := 'subscriptions',
          p_operation := 'billing_period_correction',
          p_error_class := 'exception',
          p_error_code := v_err_state,
          p_message := left(v_err_msg, 500),
          p_severity := 'error',
          p_entities := jsonb_build_object('subscription_id', r.subscription_id),
          p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
    end;
  end loop;

  return json_build_object('ok', true, 'periods_touched', v_periods_touched, 'subscriptions_failed', v_failed);
end;
$function$;
