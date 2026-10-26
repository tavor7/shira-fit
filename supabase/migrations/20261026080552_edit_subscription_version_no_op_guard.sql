-- Fix: editing a subscription without an actual business change must not create a duplicate
-- "plan change" history row.
--
-- edit_subscription_version (20261013110000) always closed the current version and inserted a new
-- one once p_effective_from reached or passed the current version's effective_from -- even when
-- price, plan_end_date and allowances were all unchanged from the current version (e.g. a manager
-- opens Edit right after Create and saves without changing anything, or re-saves the same values
-- under a different effective_from). The new row's price fell back to the unchanged price via
-- coalesce(p_new_price, v_current.monthly_price_ils), so "Plan changes" showed two back-to-back
-- entries at the identical price for no real reason. Reproduced in production: subscription
-- 249e2df8-1a70-4e3d-b74a-44578e9badb2 (Dina Gerzon) got a second version 38 seconds after create,
-- identical in every business field (price 360.00, anchor_day 22, plan_start_date, has_no_end_date,
-- and all 7 allowance tiers) to the first. This migration does NOT touch that or any other existing
-- subscription_versions/charges/payments row -- it only changes behavior for edits made from here on.
--
-- Fix: compute v_actually_changed (price / effective plan_end_date / allowances, zero-weight tiers
-- normalized out of the allowances comparison on both sides, matching how the UI already treats "0
-- per week" as "not included") right after resolving v_new_plan_end_date. When nothing actually
-- changed, skip the close-current/insert-new-version step entirely (v_new_version_id := v_current.id)
-- in both branches that otherwise do it (p_effective_from = current's effective_from with existing
-- history, and p_effective_from after it) -- no new version, no superseded_by, no allowance rewrite.
-- The reconcile and billing-correction loops below still run unconditionally for both outcomes: they
-- are idempotent no-ops when nothing changed (subscription_generate_or_correct_billing_period already
-- returns 'unchanged' and writes nothing when the recomputed amount matches the existing charge), so
-- billing behavior for genuine edits is completely unchanged and a no-op edit now writes zero ledger
-- rows instead of zero net-effect ones. A genuine change to price, plan end date or allowances still
-- takes the exact same branch (and produces the exact same new version / billing corrections) as
-- before this migration -- only the no-op path is new.
--
-- Body otherwise identical to 20261013110000's edit_subscription_version.

create or replace function public.edit_subscription_version(
  p_subscription_id uuid,
  p_effective_from date,
  p_new_price numeric default null,
  p_new_plan_end_date date default null,
  p_clear_end_date boolean default false, -- explicit "remove end date" intent; NEVER touches allowances
  p_new_allowances jsonb default null,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  v_new_version_id uuid;
  v_new_plan_end_date date;
  v_has_history boolean;
  v_rows int;
  r record;
  v_res json;
  v_current_allowances_map jsonb;
  v_new_allowances_map jsonb;
  v_actually_changed boolean;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_price is not null and p_new_price < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_effective_from is null then
    return json_build_object('ok', false, 'error', 'effective_from_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  -- Server-side impact recompute, always — never trust a client-supplied earlier preview, whether
  -- this is the first preview call or the confirmed application.
  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'edit',
    null, null, null,
    p_effective_from, p_new_price, p_new_plan_end_date, p_clear_end_date, p_new_allowances
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

  -- Whether this edit actually changes any subscription term, vs. just re-saving the form with the
  -- same price/end-date/allowances under a (possibly different) effective_from. Zero-weight tiers are
  -- normalized out of both sides before comparing allowances, matching how the UI itself treats "0
  -- per week" as "not included" (ManagerSubscriptionDetailScreen's allowances section filters the
  -- same way) -- so a resubmitted full 7-tier array with the same nonzero tiers is not a "change"
  -- just because it also spells out zeros the current version's rows happen to omit, or vice versa.
  select coalesce(jsonb_object_agg(tier::text, weekly_limit), '{}'::jsonb)
  into v_current_allowances_map
  from public.subscription_version_allowances
  where version_id = v_current.id and weekly_limit <> 0;

  if p_new_allowances is not null then
    select coalesce(jsonb_object_agg((a->>'tier'), (a->>'weekly_limit')::int), '{}'::jsonb)
    into v_new_allowances_map
    from jsonb_array_elements(p_new_allowances) a
    where (a->>'weekly_limit')::int <> 0;
  end if;

  v_actually_changed :=
    (p_new_price is not null and p_new_price is distinct from v_current.monthly_price_ils)
    or (v_new_plan_end_date is distinct from v_current.plan_end_date)
    or (p_new_allowances is not null and v_new_allowances_map is distinct from v_current_allowances_map);

  -- Idempotency (fixed — pre-merge review round 2): the key MUST distinguish a true retry of the
  -- identical request from a genuinely distinct edit that happens to share a subscription/date.
  -- Hashing subscription+action+date ALONE (the original design) collapsed two different edits
  -- effective on the same date into one "operation" — e.g. price 300 then a later, deliberate
  -- price 350 correction for the same date would have been misread as a retry of the first and
  -- silently dropped. The key now incorporates every business-relevant field actually being
  -- changed (price, resulting plan_end_date, and the canonical text form of the allowances jsonb,
  -- which is stable/order-independent since Postgres normalizes jsonb on parse) so two payloads
  -- differing in ANY of those fields always produce different keys, while two calls with an
  -- identical payload converge to the same key (a true retry).
  declare
    v_source_id uuid := md5(
      p_subscription_id::text || '|edit|' || p_effective_from::text || '|' ||
      coalesce(p_new_price::text, 'null') || '|' ||
      coalesce(v_new_plan_end_date::text, 'null') || '|' ||
      coalesce(p_new_allowances::text, 'null')
    )::uuid;
  begin
    if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
               and action_type = 'edit' and action_source_id = v_source_id and confirmed = true) then
      return json_build_object('ok', true, 'action', 'already_applied');
    end if;

    if p_effective_from < v_current.effective_from then
      return json_build_object('ok', false, 'error', 'effective_from_before_current_version');
    end if;

    if not v_actually_changed then
      -- Nothing about price, plan end date, or allowances is actually different — never close the
      -- current version or insert an identical-looking duplicate purely because the form was saved
      -- with a (possibly different) effective_from. The reconcile/billing-correction steps below
      -- still run against the unchanged current version and are no-ops (same amount -> 'unchanged',
      -- no charge rows written), so this path is a true no-op end to end.
      v_new_version_id := v_current.id;
    elsif p_effective_from = v_current.effective_from then
      -- Safety check (fixed — pre-merge review round 2): re-verified fresh against the live schema
      -- that the only two tables referencing subscription_versions.id are
      -- subscription_billing_periods.version_id and subscription_registration_coverage.version_id
      -- (subscription_version_allowances also references it, but every version has allowance rows
      -- immediately upon creation — that is configuration, not history, and is excluded here).
      select exists (
        select 1 from public.subscription_billing_periods where version_id = v_current.id
        union all
        select 1 from public.subscription_registration_coverage where version_id = v_current.id
      ) into v_has_history;

      if not v_has_history then
        -- Case (a): brand-new version, nothing depends on it yet — safe to update in place.
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
        -- Case (b): history already exists against this exact version. Never mutate it in place —
        -- close it with effective_to = its OWN effective_from (a deliberate, explicitly-safe
        -- zero-width case; see 20260924146000's constraint-relaxation comment for the proof that a
        -- zero-width version can never match any real billing segment) and insert a genuinely new
        -- version at that same date. The original row's fields are never touched, preserving full
        -- auditability, while "from the beginning" semantics and correct corrections are honored
        -- via the normal reconcile/billing-correction steps below.
        update public.subscription_versions
        set effective_to = p_effective_from
        where id = v_current.id and effective_to is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          return json_build_object('ok', false, 'error', 'concurrent_modification');
        end if;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_uid
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
      set effective_to = p_effective_from
      where id = v_current.id and effective_to is null;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', false, 'error', 'concurrent_modification');
      end if;

      insert into public.subscription_versions (
        subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
        plan_start_date, plan_end_date, created_by
      ) values (
        p_subscription_id,
        (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
        p_effective_from,
        coalesce(p_new_price, v_current.monthly_price_ils),
        v_current.anchor_day,
        v_current.plan_start_date,
        v_new_plan_end_date,
        v_uid
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

    -- Reconcile every affected (tier, week_start) for real.
    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (p_effective_from - extract(dow from p_effective_from)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    -- Billing corrections for every existing billing period that overlaps the new version's
    -- effective window, through the Phase 3 correction engine, keyed to this edit's deterministic
    -- (now payload-inclusive) source_event_id (idempotent — a retry converges to
    -- 'unchanged'/'already_corrected').
    -- The engine takes RAW (unshifted) period bounds and adds the frozen days itself (20260928141108); passing the
    -- already-shifted effective dates made it shift twice, miss the existing row (unique on raw_period_start) and
    -- insert a duplicate billing period with a second full charge whenever the subscription had a freeze.
    for r in
      select bp.raw_period_start, bp.raw_period_end
      from public.subscription_billing_periods bp
      where bp.subscription_id = p_subscription_id
        and bp.period_end > p_effective_from
      order by bp.raw_period_start asc
    loop
      perform public.subscription_generate_or_correct_billing_period(
        p_subscription_id, v_new_version_id, r.raw_period_start, r.raw_period_end,
        v_source_id, 'edit_correction'
      );
    end loop;

    insert into public.subscription_impact_events (
      subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
    ) values (
      p_subscription_id, 'edit', v_source_id, p_effective_from, true, v_uid
    )
    on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

    return json_build_object('ok', true, 'action', 'applied', 'version_id', v_new_version_id, 'impact', v_impact);
  end;
end;
$$;

comment on function public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean) is
  'Manager-only. Applies (or previews) an edit to a subscription''s price/plan-end-date/allowances. '
  'Never closes the current version or inserts a new one when price, effective plan_end_date and '
  'allowances (zero-weight tiers normalized out) are all unchanged from the current version -- only '
  'a genuine change to one of those three creates a new subscription_versions row.';
