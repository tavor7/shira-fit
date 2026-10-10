-- Fix: subscription_compute_impact failed for every API caller with
--   ERROR 21000 "DELETE requires a WHERE clause"   (PostgREST: HTTP 400)
-- because it cleared its scratch table with a bare `delete from _subscription_impact_before;` and the
-- `authenticator` role (which PostgREST connects as) preloads the `safeupdate` extension, which rejects
-- any DELETE/UPDATE without a WHERE clause -- even inside a SECURITY DEFINER function. The function is
-- called unconditionally by edit_subscription_version, freeze_subscription and stop_subscription (preview
-- AND confirmed), so none of the three has ever been usable through the API.
--
-- The scratch table is `create temporary table if not exists ... on commit drop`: it is private to the
-- transaction and is only a snapshot of this call's "before" coverage. The DELETE exists so a second call
-- inside the same transaction does not collide on the primary key, i.e. it is meant to remove EVERY row.
-- `coverage_id` is the primary key (never null), so `where coverage_id is not null` selects exactly the
-- same rows while satisfying safeupdate. safeupdate itself and the authenticator role settings are
-- untouched. The rest of the function is byte-for-byte the definition from
-- 20260928141108_subscriptions_freeze_pause_semantics.sql. Code only: no data is read or written.

create or replace function public.subscription_compute_impact(
  p_subscription_id uuid,
  p_action_type public.subscription_impact_action_type,
  p_freeze_from date default null,
  p_freeze_until date default null,
  p_stop_date date default null,
  p_new_effective_from date default null,
  p_new_price numeric default null,
  p_new_plan_end_date date default null,
  p_clear_end_date boolean default false,
  p_new_allowances jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_current public.subscription_versions%rowtype;
  v_new_version_id uuid;
  v_freeze_id uuid;
  v_range_start date;
  v_items jsonb := '[]'::jsonb;
  v_count int := 0;
  v_has_history boolean;
  v_new_plan_end_date date;
  v_preview_next_billing_date date;
  v_preview_effective_plan_end_date date;
  r record;
  v_after public.subscription_registration_coverage%rowtype;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id and deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if p_action_type = 'freeze' then
    if p_freeze_from is null or p_freeze_until is null then
      return jsonb_build_object('ok', false, 'error', 'freeze_dates_required');
    end if;
    v_range_start := p_freeze_from;
  elsif p_action_type = 'stop' then
    if p_stop_date is null then
      return jsonb_build_object('ok', false, 'error', 'stop_date_required');
    end if;
    v_range_start := p_stop_date;
  elsif p_action_type = 'edit' then
    if p_new_effective_from is null then
      return jsonb_build_object('ok', false, 'error', 'effective_from_required');
    end if;
    v_range_start := p_new_effective_from;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported_action_type');
  end if;

  create temporary table if not exists _subscription_impact_before (
    coverage_id uuid primary key,
    covered boolean not null
  ) on commit drop;
  delete from _subscription_impact_before where coverage_id is not null;

  insert into _subscription_impact_before (coverage_id, covered)
  select id, covered from public.subscription_registration_coverage
  where subscription_id = p_subscription_id;

  begin
    if p_action_type = 'freeze' then
      insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
      values (p_subscription_id, p_freeze_from, p_freeze_until)
      returning id into v_freeze_id;

    elsif p_action_type = 'stop' then
      update public.subscription_versions
      set stopped_effective_date = p_stop_date
      where id = v_current.id;

    elsif p_action_type = 'edit' then
      v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

      if p_new_effective_from < v_current.effective_from then
        return jsonb_build_object('ok', false, 'error', 'effective_from_before_current_version');
      end if;

      if p_new_effective_from = v_current.effective_from then
        select exists (
          select 1 from public.subscription_billing_periods where version_id = v_current.id
          union all
          select 1 from public.subscription_registration_coverage where version_id = v_current.id
        ) into v_has_history;

        if not v_has_history then
          update public.subscription_versions
          set monthly_price_ils = coalesce(p_new_price, v_current.monthly_price_ils),
              plan_end_date = v_new_plan_end_date
          where id = v_current.id;
          v_new_version_id := v_current.id;

          if p_new_allowances is not null then
            delete from public.subscription_version_allowances where version_id = v_current.id;
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_current.id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          end if;
        else
          update public.subscription_versions
          set effective_to = p_new_effective_from
          where id = v_current.id;

          insert into public.subscription_versions (
            subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
            plan_start_date, plan_end_date, created_by
          ) values (
            p_subscription_id,
            (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
            p_new_effective_from,
            coalesce(p_new_price, v_current.monthly_price_ils),
            v_current.anchor_day,
            v_current.plan_start_date,
            v_new_plan_end_date,
            v_current.created_by
          ) returning id into v_new_version_id;

          update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

          if p_new_allowances is not null then
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          else
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, tier, weekly_limit
            from public.subscription_version_allowances where version_id = v_current.id;
          end if;
        end if;
      else
        update public.subscription_versions
        set effective_to = p_new_effective_from
        where id = v_current.id;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_new_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_current.created_by
        ) returning id into v_new_version_id;

        update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

        if p_new_allowances is not null then
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        else
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, tier, weekly_limit
          from public.subscription_version_allowances where version_id = v_current.id;
        end if;
      end if;
    end if;

    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (v_range_start - extract(dow from v_range_start)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    if p_action_type = 'freeze' then
      -- Actually run the real billing-period correction inside this rolled-back block, so the
      -- preview's derived dates come from the exact same authoritative logic the real freeze will
      -- use -- never computed independently here.
      for r in
        select bp.raw_period_start, bp.raw_period_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = p_subscription_id
          and bp.raw_period_end >= p_freeze_from
      loop
        perform public.subscription_generate_or_correct_billing_period(
          p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_freeze_id, 'freeze_credit'
        );
      end loop;

      v_preview_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
      v_preview_effective_plan_end_date := public.subscription_effective_plan_end_date(v_current.id);
    end if;

    for v_after in
      select cov.*
      from public.subscription_registration_coverage cov
      join _subscription_impact_before b on b.coverage_id = cov.id
      where cov.subscription_id = p_subscription_id
        and b.covered = true
        and cov.covered = false
    loop
      v_count := v_count + 1;
      v_items := v_items || jsonb_build_object(
        'registration_id', v_after.registration_id,
        'manual_participant_id', v_after.manual_participant_id,
        'session_date', v_after.session_date,
        'week_start', v_after.week_start,
        'tier', v_after.tier,
        'new_non_coverage_reason', v_after.non_coverage_reason
      );
    end loop;

    raise exception using errcode = 'ZZ001', message = 'subscription_impact_preview_rollback';
  exception
    when sqlstate 'ZZ001' then
      null;
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'items', v_items,
    'current_monthly_price_ils', v_current.monthly_price_ils,
    'preview_next_billing_date', v_preview_next_billing_date,
    'preview_effective_plan_end_date', v_preview_effective_plan_end_date,
    'estimate_note',
      'count is exact (recomputed via the real subscription_reconcile_week algorithm under the ' ||
      'hypothetical state, then rolled back). A precise dollar figure is intentionally not ' ||
      'estimated here — the exact amount is determined by subscription_generate_or_correct_' ||
      'billing_period at confirm time, which segments real calendar days across real prices. For a ' ||
      'freeze specifically, preview_next_billing_date/preview_effective_plan_end_date are computed '||
      'by actually running that same correction logic inside this rolled-back preview.'
  );
end;
$$;

comment on function public.subscription_compute_impact(
  uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb
) is
  'Shared, reusable, side-effect-free impact-preview engine for freeze/stop/edit. For freeze, also '
  'runs the real billing-period correction (raw-bounds based) inside the rolled-back block so '
  'preview_next_billing_date/preview_effective_plan_end_date reflect authoritative backend logic, '
  'not a frontend/duplicate calculation. Always rolls back via a sentinel exception.';
