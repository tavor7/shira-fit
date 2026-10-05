-- Make per-subscription failures in the daily billing job visible.
--
-- generate_due_subscription_charges() isolates each subscription in a sub-transaction and, on any
-- error, only incremented a counter. That counter is returned as JSON, but the pg_cron job is
-- `select public.generate_due_subscription_charges();`, so the result is discarded: cron reports
-- "succeeded", and there was no record of WHICH subscription failed or WHY. A subscription whose
-- billing period could not be generated stayed silently unbilled (it is retried on the next daily
-- run by the existing stranded-period logic, but nobody would know it was stuck).
--
-- Fix: when a subscription fails, record a 'subscription_billing_failed' event (subscription id,
-- SQLSTATE, message) in the manager activity log. The write is itself guarded so logging can never
-- break the job. Billing logic, ordering and retry behaviour are unchanged. Function body only.
CREATE OR REPLACE FUNCTION public.generate_due_subscription_charges()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    end;
  end loop;

  return json_build_object('ok', true, 'periods_touched', v_periods_touched, 'subscriptions_failed', v_failed);
end;
$function$

;
