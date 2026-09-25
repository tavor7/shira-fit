-- Subscription Management — Phase 4A: manager-facing backend CRUD (no UI, see plan §Phase 4).
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md.
--
-- Scope: create_subscription, list_active_subscriptions, list_subscription_history,
-- get_subscription_detail, subscription_compute_impact (shared preview engine),
-- edit_subscription_version, freeze_subscription, stop_subscription, delete_subscription,
-- reactivate_subscription. Every RPC here is a thin, authoritative wrapper around the Phase 1-3
-- primitives (subscription_effective_context, subscription_reconcile_week,
-- subscription_generate_or_correct_billing_period, subscription_version_display_status,
-- subscription_lock_key) — no business logic is duplicated.
--
-- Judgment calls made in this migration (see checkpoint report §14 for the full write-up):
--  1. No distinct "admin" role exists in this codebase (user_role = athlete/coach/manager only,
--     confirmed by inspection of 20250314000000_initial.sql). is_manager() is used as the sole
--     staff-privilege check for every RPC below.
--  2. "Conflicting active subscription lineage": create_subscription rejects a new subscription for
--     a payee who already has a non-tombstoned subscription whose CURRENT version's display status
--     (as of the new subscription's start date) is not 'stopped' or 'completed' — i.e. active,
--     frozen, or scheduled lineages block a second concurrent lineage; stopped/completed do not.
--  3. [REVISED — pre-merge review round 2] has_no_end_date (renamed from is_unlimited in
--     20260924146000_subscriptions_has_no_end_date.sql): re-inspection of the plan confirmed
--     "unlimited / no end" refers exclusively to subscription DURATION (paired with plan_end_date
--     in the plan's own field list, feeding subscription_version_display_status's 'completed'
--     check), never to weekly session allowances. The original Phase 4A draft's 100000-sentinel
--     workaround conflated the two and has been REMOVED ENTIRELY. has_no_end_date is now a
--     GENERATED column (plan_end_date IS NULL) — no RPC ever sets it directly; a new p_clear_end_date
--     boolean (create/edit) explicitly controls only plan_end_date, never weekly_limit. Weekly
--     allowance is always stored exactly as configured, indefinitely, regardless of duration.
--  3b. [Added — pre-merge review round 2] In-place version edits are now gated by an actual
--     dependency check, not just date equality: edit_subscription_version/subscription_compute_impact
--     query subscription_billing_periods.version_id and subscription_registration_coverage.version_id
--     (the only two tables that reference subscription_versions.id — re-verified fresh against the
--     live schema, see inline comment at the check site) before allowing an in-place update. If the
--     version already has such history, the edit instead closes it with effective_to = its own
--     effective_from (a relaxed, explicitly-safe zero-width case — see
--     20260924146000_subscriptions_has_no_end_date.sql's constraint-relaxation comment for the proof
--     that a zero-width version can never match any real billing segment) and inserts a genuinely new
--     version, preserving the original row completely unmutated for audit purposes.
--  3c. [Added — pre-merge review round 2] source_event_id for edit_subscription_version is now a hash
--     of the FULL business payload (price, plan_end_date, clear_end_date, allowances), not just
--     subscription+date, so two distinct edits effective on the same date never collide into a false
--     "retry". freeze_subscription/stop_subscription's existing keys were re-audited and found already
--     complete (freeze_from+freeze_until and stop_date respectively ARE their entire payload — no
--     other business field varies independently), so those are unchanged.
--  4. Family members are NOT a third payee kind: athlete_family_members (20260628000000) wraps an
--     existing profiles.user_id or manual_participants.id purely for aggregated display; the
--     existing payee_id/payee_is_manual dual-payee convention already covers a family member
--     exactly like any other athlete or manual participant. No new payee representation is added.
--  5. Concurrency: reuses subscription_lock_key/pg_advisory_xact_lock exactly (via
--     subscription_reconcile_week, called for every affected week/tier, which already takes that
--     lock) rather than inventing a second locking primitive. For the subscription-lineage-level
--     race (two concurrent edits/freezes/stops on the same subscription, or edit-vs-cron), this
--     migration adds ONE new advisory-lock keyed by a namespaced string built the same way
--     subscription_lock_key builds its key (hashtextextended over a descriptive string, seed 0) —
--     see subscription_admin_lock_key below — plus an optimistic-concurrency check when closing the
--     "current" version row (UPDATE ... WHERE id = <expected> RETURNING, checked via
--     GET DIAGNOSTICS, raising subscription_concurrent_modification on a miss).
--  6. New subscription_charge_type value 'edit_correction' (added in the preceding migration,
--     20260924145000_subscriptions_edit_correction_charge_type.sql — new enum values must live in
--     their own migration/transaction before use, per this codebase's own established convention,
--     see 20260915100000_legal_consent_enum_values.sql): found during Phase 4A testing that reusing
--     'proration' (Phase 3's organic-partial-period type) for an edit's billing correction collides
--     with subscription_charges_original_per_period_uidx (unique on billing_period_id WHERE
--     charge_type IN ('recurring','proration')) — that index exists specifically so exactly one
--     "original" charge exists per period, and 'proration' is deliberately IN its scope. Every
--     Phase 3 correction type (freeze_credit, stop_proration) was deliberately chosen to fall
--     OUTSIDE that scope so a correction can coexist with the original charge it reverses; a plain
--     price/allowance edit had no dedicated type yet, so a new one was added, following the exact
--     same pattern.

-- ---------------------------------------------------------------------------
-- 0. subscription_admin_lock_key — same hashtextextended(text, 0) mechanism as
--    subscription_lock_key, just a differently-shaped (namespaced) key so it can never collide
--    with a payee/week/tier key built by that function.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_admin_lock_key(p_subscription_id uuid)
returns bigint
language sql
immutable
as $$
  select hashtextextended('subscription_admin:' || coalesce(p_subscription_id::text, ''), 0);
$$;

create or replace function public.subscription_payee_create_lock_key(p_payee_id uuid, p_payee_is_manual boolean)
returns bigint
language sql
immutable
as $$
  select hashtextextended(
    'subscription_create:' || coalesce(p_payee_id::text, '') || '|' || coalesce(p_payee_is_manual::text, 'false'),
    0
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. subscription_compute_impact — shared, reusable impact-preview engine for freeze/stop/edit.
--
-- Mechanism: applies the hypothetical change (new freeze row / stopped_effective_date / new
-- version+allowances) inside a NESTED plpgsql block, re-runs the real subscription_reconcile_week
-- for every (tier, week_start) this subscription has ever had a coverage decision for at/after the
-- action's effective date (only real, already-decided registrations can ever "flip" — there is
-- nothing to preview for hypothetical future registrations that don't exist yet), diffs
-- covered=true -> covered=false rows, then ALWAYS rolls back the nested block via a sentinel
-- exception (plpgsql local variables survive a ROLLBACK TO SAVEPOINT — only table writes are
-- undone), so this function never has a side effect regardless of who calls it or how many times.
-- The real mutating RPCs below call this once for preview, and call it AGAIN for server-side
-- re-verification at confirm time (never trusting the client's earlier preview), then perform the
-- real (non-rolled-back) mutation themselves.
-- ---------------------------------------------------------------------------

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
  delete from _subscription_impact_before;

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
        -- Targets a date before the current version even started (either before the subscription
        -- existed at all, or inside an older, already-superseded version) — not supported by this
        -- RPC; "from the beginning" always means the CURRENT version's own effective_from (see the
        -- p_new_effective_from = v_current.effective_from branch below), never an earlier one.
        return jsonb_build_object('ok', false, 'error', 'effective_from_before_current_version');
      end if;

      if p_new_effective_from = v_current.effective_from then
        -- Re-verified fresh against the live schema (not assumed from the earlier Phase 4A pass):
        -- the only two tables that reference subscription_versions.id are
        -- subscription_billing_periods.version_id and subscription_registration_coverage.version_id
        -- (subscription_version_allowances also references it, but every version — including a
        -- brand-new one, immediately after creation — always has allowance rows; that is
        -- configuration, not history, and is deliberately excluded from this check).
        select exists (
          select 1 from public.subscription_billing_periods where version_id = v_current.id
          union all
          select 1 from public.subscription_registration_coverage where version_id = v_current.id
        ) into v_has_history;

        if not v_has_history then
          -- Case (a): truly brand-new version, nothing depends on it yet — safe to update in place.
          -- No billing period or coverage decision could ever reference a window that never existed.
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
          -- Case (b): history already exists against this exact version. Do NOT mutate it in place
          -- (that would silently rewrite what billing/coverage already recorded as true). Instead
          -- close it with effective_to = its OWN effective_from — a deliberate, explicitly-safe
          -- zero-width case (see 20260924146000's constraint-relaxation comment: a zero-width
          -- version can never match any real billing segment, so this is provably inert for
          -- pricing/coverage) — and insert a genuinely new version at that same date. The original
          -- row's own fields (price, dates, id) are never touched, preserving full auditability;
          -- "from the beginning" semantics are honored because the new version's effective_from
          -- equals the subscription's own start, and the normal correction loop below re-prices
          -- every existing billing period under the new version.
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
        -- p_new_effective_from > v_current.effective_from: the normal "from a specific date" path,
        -- which may fall inside an already-generated billing period — Phase 3's segmentation engine
        -- handles that automatically via the correction loop below.
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
      null; -- expected sentinel: discards every tentative write made above, keeps computed locals
    when exclusion_violation then
      -- The hypothetical freeze itself overlaps an existing (real) freeze — the action is
      -- impossible regardless of impact, so surface that directly rather than letting the raw
      -- constraint error propagate. freeze_subscription's own real-apply attempt would hit the
      -- exact same constraint; returning it here means the caller never gets that far.
      return jsonb_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'items', v_items,
    'current_monthly_price_ils', v_current.monthly_price_ils,
    'estimate_note',
      'count is exact (recomputed via the real subscription_reconcile_week algorithm under the ' ||
      'hypothetical state, then rolled back). A precise dollar figure is intentionally not ' ||
      'estimated here — the exact amount is determined by subscription_generate_or_correct_' ||
      'billing_period at confirm time, which segments real calendar days across real prices.'
  );
end;
$$;

comment on function public.subscription_compute_impact(
  uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb
) is
  'Shared, reusable, side-effect-free impact-preview engine for freeze/stop/edit. Applies the '
  'hypothetical change in a nested block, re-runs subscription_reconcile_week for real, diffs '
  'covered=true -> covered=false, then always rolls back via a sentinel exception. Manager RPCs '
  'call this both for preview and again for server-side re-verification at confirm time.';

-- No grant: internal helper, only ever called by the manager-only entry points below (all
-- SECURITY DEFINER, need no separate grant), matching the Phase 1-2 hardening convention.

-- ---------------------------------------------------------------------------
-- 2. create_subscription
-- ---------------------------------------------------------------------------

create or replace function public.create_subscription(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_monthly_price_ils numeric,
  p_start_date date,
  p_end_date date default null, -- null = no end date (has_no_end_date derives to true); never affects allowances
  p_anchor_day smallint default null,
  p_allowances jsonb default '[]'::jsonb -- [{"tier":"pair","weekly_limit":2}, ...]
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_subscription_id uuid;
  v_version_id uuid;
  v_anchor smallint;
  v_conflict record;
  v_tier public.subscription_tier;
  v_seen_tiers public.subscription_tier[] := '{}';
  a jsonb;
  v_limit int;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_monthly_price_ils is null or p_monthly_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_payee_id is null then
    return json_build_object('ok', false, 'error', 'invalid_payee');
  end if;

  -- Exactly one valid payee identity, reusing the existing validation trigger
  -- (_validate_subscription_payee) at INSERT time below; here we only reject the obviously-wrong
  -- shape early (dual-payee XOR is inherent to the two-column model, not a two-nullable-column
  -- pattern, so there is nothing further to XOR-check at this layer).

  perform pg_advisory_xact_lock(public.subscription_payee_create_lock_key(p_payee_id, p_payee_is_manual));

  -- Conflicting-active-subscription-lineage rule (judgment call — see migration header §2):
  -- reject if this payee already has a non-tombstoned subscription whose CURRENT version's
  -- display status as of p_start_date is not 'stopped'/'completed'.
  select s.id into v_conflict
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.payee_id = p_payee_id
    and s.payee_is_manual = coalesce(p_payee_is_manual, false)
    and s.deleted_at is null
    and public.subscription_version_display_status(v.id, p_start_date) not in ('stopped', 'completed')
  limit 1;

  if found then
    return json_build_object('ok', false, 'error', 'conflicting_active_subscription', 'subscription_id', v_conflict.id);
  end if;

  v_anchor := coalesce(p_anchor_day, extract(day from p_start_date)::smallint);
  if v_anchor < 1 or v_anchor > 31 then
    return json_build_object('ok', false, 'error', 'invalid_anchor_day');
  end if;

  insert into public.subscriptions (payee_id, payee_is_manual, created_by)
  values (p_payee_id, coalesce(p_payee_is_manual, false), v_uid)
  returning id into v_subscription_id;

  insert into public.subscription_versions (
    subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
    plan_start_date, plan_end_date, created_by
  ) values (
    v_subscription_id, 1, p_start_date, p_monthly_price_ils, v_anchor,
    p_start_date, p_end_date, v_uid
  ) returning id into v_version_id;

  -- Normalize allowances: exactly one row per subscription_tier, defaulting an unspecified tier to
  -- weekly_limit 0 (tier not included), validating each supplied entry is a real tier with a
  -- non-negative integer limit. Stored exactly as configured, regardless of duration/end-date —
  -- has_no_end_date (derived from p_end_date) never affects weekly_limit in any way.
  for v_tier in select unnest(enum_range(null::public.subscription_tier)) loop
    v_limit := 0;
    for a in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
      if (a->>'tier')::public.subscription_tier = v_tier then
        v_limit := (a->>'weekly_limit')::int;
      end if;
    end loop;
    if v_limit is null or v_limit < 0 then
      return json_build_object('ok', false, 'error', 'invalid_allowance', 'tier', v_tier::text);
    end if;
    insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
    values (v_version_id, v_tier, v_limit);
  end loop;

  -- Immediate first billing if the start date is today/past — reuses the exact Phase 3 engine,
  -- the same call generate_due_subscription_charges makes for a subscription's first period. If
  -- p_start_date is in the future, this call's own guard (v_next_start > v_today check lives in
  -- the daily job, not here) is replicated inline: only bill immediately when due.
  if p_start_date <= public._studio_today_date() then
    perform public.subscription_generate_or_correct_billing_period(
      v_subscription_id, v_version_id, p_start_date,
      public.subscription_next_anchor_date(v_anchor, p_start_date),
      null, null
    );
  end if;

  return json_build_object('ok', true, 'subscription_id', v_subscription_id, 'version_id', v_version_id);
end;
$$;

comment on function public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb) is
  'Manager-only. Creates a new subscription lineage (subscriptions + first subscription_versions + '
  'subscription_version_allowances row), rejecting a conflicting non-tombstoned lineage for the '
  'same payee, then invokes the existing Phase 3 billing engine for the first period if due today. '
  'p_end_date = null means no end date (has_no_end_date derives to true); this never affects '
  'p_allowances, which is always stored exactly as configured.';

grant execute on function public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Read/list RPCs — manager-only. Tombstoned subscriptions never appear as a manageable entry
--    in either list, but remain fully queryable via get_subscription_detail (and are never
--    excluded from _period_merged_athlete_finance, which was already verified in Phase 3 to read
--    exclusively from subscription_charges, not from subscriptions.deleted_at).
-- ---------------------------------------------------------------------------

create or replace function public.list_active_subscriptions()
returns table (
  subscription_id uuid,
  payee_id uuid,
  payee_is_manual boolean,
  payee_display_name text,
  version_id uuid,
  display_status text,
  monthly_price_ils numeric,
  anchor_day smallint,
  plan_start_date date,
  plan_end_date date,
  has_no_end_date boolean,
  next_billing_date date,
  is_frozen boolean,
  current_weekly_limits jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  return query
  select
    s.id,
    s.payee_id,
    s.payee_is_manual,
    coalesce(
      case when not s.payee_is_manual then p.full_name else mp.full_name end,
      '(unknown)'
    ),
    v.id,
    public.subscription_version_display_status(v.id, public._studio_today_date()),
    v.monthly_price_ils,
    v.anchor_day,
    v.plan_start_date,
    v.plan_end_date,
    v.has_no_end_date,
    public.subscription_next_anchor_date(v.anchor_day, coalesce(
      (select max(bp.period_start) from public.subscription_billing_periods bp where bp.subscription_id = s.id),
      v.plan_start_date - 1
    )),
    exists (
      select 1 from public.subscription_freezes f
      where f.subscription_id = s.id and f.cancelled_at is null
        and public._studio_today_date() between f.freeze_from and f.freeze_until
    ),
    coalesce((
      select jsonb_object_agg(a.tier::text, a.weekly_limit)
      from public.subscription_version_allowances a
      where a.version_id = v.id
    ), '{}'::jsonb)
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) not in ('stopped', 'completed')
  order by s.created_at desc;
end;
$$;

comment on function public.list_active_subscriptions() is
  'Manager-only. Every non-tombstoned subscription whose current version is not stopped/completed '
  'as of today, joined to profiles/manual_participants for display. Returns nothing for a non-manager.';

grant execute on function public.list_active_subscriptions() to authenticated;

create or replace function public.list_subscription_history()
returns table (
  subscription_id uuid,
  payee_id uuid,
  payee_is_manual boolean,
  payee_display_name text,
  version_id uuid,
  display_status text,
  monthly_price_ils numeric,
  plan_start_date date,
  plan_end_date date,
  is_tombstoned boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  return query
  select
    s.id,
    s.payee_id,
    s.payee_is_manual,
    coalesce(
      case when not s.payee_is_manual then p.full_name else mp.full_name end,
      '(unknown)'
    ),
    v.id,
    public.subscription_version_display_status(v.id, public._studio_today_date()),
    v.monthly_price_ils,
    v.plan_start_date,
    v.plan_end_date,
    s.deleted_at is not null
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  where s.deleted_at is not null
     or public.subscription_version_display_status(v.id, public._studio_today_date()) in ('stopped', 'completed')
  order by s.created_at desc;
end;
$$;

comment on function public.list_subscription_history() is
  'Manager-only. Every subscription that is tombstoned OR whose current version is stopped/'
  'completed as of today — i.e. everything list_active_subscriptions excludes.';

grant execute on function public.list_subscription_history() to authenticated;

create or replace function public.get_subscription_detail(p_subscription_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_versions jsonb;
  v_freezes jsonb;
  v_periods jsonb;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(v) - 'created_by' || jsonb_build_object(
    'display_status', public.subscription_version_display_status(v.id, public._studio_today_date()),
    'allowances', (
      select coalesce(jsonb_object_agg(a.tier::text, a.weekly_limit), '{}'::jsonb)
      from public.subscription_version_allowances a where a.version_id = v.id
    )
  ) order by v.version_no), '[]'::jsonb)
  into v_versions
  from public.subscription_versions v
  where v.subscription_id = p_subscription_id;

  select coalesce(jsonb_agg(to_jsonb(f) order by f.freeze_from), '[]'::jsonb)
  into v_freezes
  from public.subscription_freezes f
  where f.subscription_id = p_subscription_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'period_id', bp.id,
    'period_start', bp.period_start,
    'period_end', bp.period_end,
    'charges', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb)
      from public.subscription_charges c where c.billing_period_id = bp.id
    )
  ) order by bp.period_start), '[]'::jsonb)
  into v_periods
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_subscription_id;

  return json_build_object(
    'ok', true,
    'subscription', to_jsonb(v_sub),
    'versions', v_versions,
    'freezes', v_freezes,
    'billing_periods', v_periods
  );
end;
$$;

comment on function public.get_subscription_detail(uuid) is
  'Manager-only. Full version/freeze/billing-period/charge history for one subscription, '
  'including tombstoned subscriptions — historical financial facts are always queryable here.';

grant execute on function public.get_subscription_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. edit_subscription_version — mandatory impact-preview/confirm pattern.
-- ---------------------------------------------------------------------------

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

    if p_effective_from = v_current.effective_from then
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
    for r in
      select bp.id, bp.period_start, bp.period_end
      from public.subscription_billing_periods bp
      where bp.subscription_id = p_subscription_id
        and bp.period_end > p_effective_from
    loop
      perform public.subscription_generate_or_correct_billing_period(
        p_subscription_id, v_new_version_id, r.period_start, r.period_end,
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
  'Manager-only. Mandatory impact-preview/p_confirmed pattern: recomputes impact via '
  'subscription_compute_impact both for the initial preview and again at confirm time. Never '
  'mutates a version with existing billing/coverage history in place (closes it at a verified-safe '
  'zero-width boundary and inserts a new one instead — see inline comments); a brand-new version '
  'with no history yet may be updated in place. Reconciles affected weeks and corrects overlapping '
  'billing periods via the Phase 3 engine, keyed to a source_event_id that hashes the FULL business '
  'payload (price/plan_end_date/allowances), not just subscription+date, so distinct same-date '
  'edits never collide. p_clear_end_date explicitly controls only plan_end_date, never allowances.';

grant execute on function public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. freeze_subscription — same impact-preview/confirm pattern. Anchor never moves; allowance
--    numbers are never prorated, only billing dollars and coverage eligibility for frozen dates.
-- ---------------------------------------------------------------------------

create or replace function public.freeze_subscription(
  p_subscription_id uuid,
  p_freeze_from date,
  p_freeze_until date,
  p_confirmed boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_impact jsonb;
  v_freeze_id uuid;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_freeze_from is null or p_freeze_until is null or p_freeze_until < p_freeze_from then
    return json_build_object('ok', false, 'error', 'invalid_freeze_dates');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  if not exists (select 1 from public.subscriptions where id = p_subscription_id and deleted_at is null) then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'freeze', p_freeze_from, p_freeze_until
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|freeze|' || p_freeze_from::text || '|' || p_freeze_until::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'freeze' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  -- Reuses the existing exclusion constraint (subscription_freezes_no_overlap_excl) for overlap
  -- rejection — no separate overlap check duplicated here.
  begin
    insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until, created_by)
    values (p_subscription_id, p_freeze_from, p_freeze_until, v_uid)
    returning id into v_freeze_id;
  exception
    when exclusion_violation then
      return json_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_freeze_from - extract(dow from p_freeze_from)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  -- Multi-period freezes: correct every billing period the freeze window overlaps.
  for r in
    select bp.id, bp.period_start, bp.period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_start <= p_freeze_until and bp.period_end > p_freeze_from
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id,
      (select id from public.subscription_versions where subscription_id = p_subscription_id and effective_to is null),
      r.period_start, r.period_end, v_source_id, 'freeze_credit'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'freeze', v_source_id, p_freeze_from, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object('ok', true, 'action', 'applied', 'freeze_id', v_freeze_id, 'impact', v_impact);
end;
$$;

comment on function public.freeze_subscription(uuid, date, date, boolean) is
  'Manager-only. Impact-preview/confirm freeze. Reuses subscription_freezes_no_overlap_excl for '
  'overlap rejection, subscription_reconcile_week for coverage, and the Phase 3 segmentation engine '
  '(via subscription_generate_or_correct_billing_period) for multi-period billing correction.';

grant execute on function public.freeze_subscription(uuid, date, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. stop_subscription — same pattern. Retroactive stop (past effective date, after a charge
--    already posted) goes through the same reversal+correction path Phase 3 already built.
-- ---------------------------------------------------------------------------

create or replace function public.stop_subscription(
  p_subscription_id uuid,
  p_stop_date date,
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
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  v_impact := public.subscription_compute_impact(p_subscription_id, 'stop', null, null, p_stop_date);
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|stop|' || p_stop_date::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_stop_date - extract(dow from p_stop_date)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  -- Current billing period (and any later ones, if the stop date is itself retroactive to an
  -- already-billed later period, e.g. a crash-recovered catch-up) prorated via the existing
  -- correction engine.
  for r in
    select bp.id, bp.period_start, bp.period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end > p_stop_date
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_current.id, r.period_start, r.period_end, v_source_id, 'stop_proration'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object('ok', true, 'action', 'applied', 'impact', v_impact);
end;
$$;

comment on function public.stop_subscription(uuid, date, boolean) is
  'Manager-only. Impact-preview/confirm stop; sets stopped_effective_date on the current version '
  '(never a new version), prorates via the existing Phase 3 correction engine including retroactive '
  'stops after a charge already posted. All historical versions/periods/charges are untouched.';

grant execute on function public.stop_subscription(uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. delete_subscription — tombstone. Distinct from stop. Never a hard DELETE of financial rows.
-- ---------------------------------------------------------------------------

create or replace function public.delete_subscription(p_subscription_id uuid)
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

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  if not exists (select 1 from public.subscriptions where id = p_subscription_id) then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Tombstone only. generate_due_subscription_charges already filters `where s.deleted_at is
  -- null` (verified by inspection of 20260924140000_subscriptions_billing_engine.sql line ~437 and
  -- re-verified by test 100 below), so setting deleted_at here is sufficient, on its own, to stop
  -- all future billing — no separate "cancel pending periods" step is needed or exists to bypass.
  -- Future benefits stop the same way: subscription_effective_context's own query already filters
  -- `and s.deleted_at is null`, so a tombstoned subscription grants no further coverage regardless
  -- of caller. Every posted financial fact (subscription_charges rows) is untouched and remains
  -- readable via get_subscription_detail and _period_merged_athlete_finance (neither ever filters
  -- on subscriptions.deleted_at — confirmed by inspection; subscription_charges.subscription_id is
  -- nullable specifically so this survives even a future hard-delete of the subscriptions row,
  -- which this RPC never performs).
  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  return json_build_object('ok', true, 'action', 'tombstoned');
end;
$$;

comment on function public.delete_subscription(uuid) is
  'Manager-only. Tombstones (deleted_at) — never a hard DELETE. Safe to call directly with no UI '
  'confirmation: generate_due_subscription_charges and subscription_effective_context both already '
  'filter deleted_at IS NULL, so this alone stops all future billing/benefits; posted charges are '
  'untouched and remain visible in get_subscription_detail and _period_merged_athlete_finance.';

grant execute on function public.delete_subscription(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. reactivate_subscription — new lineage, never reopens the old one.
-- ---------------------------------------------------------------------------

create or replace function public.reactivate_subscription(
  p_source_subscription_id uuid,
  p_start_date date,
  p_end_date date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_src_sub public.subscriptions%rowtype;
  v_src_version public.subscription_versions%rowtype;
  v_new_sub_id uuid;
  v_new_version_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;

  select * into v_src_sub from public.subscriptions where id = p_source_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'source_subscription_not_found');
  end if;

  -- Copy from whichever version is most representative of the source's settings: its most recent
  -- (highest version_no) version, regardless of that source subscription's own current tombstoned/
  -- stopped state — reactivate is explicitly meant to work from historical/stopped/tombstoned
  -- subscriptions.
  select * into v_src_version from public.subscription_versions
  where subscription_id = p_source_subscription_id
  order by version_no desc limit 1;
  if not found then
    return json_build_object('ok', false, 'error', 'source_has_no_version');
  end if;

  perform pg_advisory_xact_lock(public.subscription_payee_create_lock_key(v_src_sub.payee_id, v_src_sub.payee_is_manual));

  if exists (
    select 1 from public.subscriptions s
    join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
    where s.payee_id = v_src_sub.payee_id
      and s.payee_is_manual = v_src_sub.payee_is_manual
      and s.deleted_at is null
      and public.subscription_version_display_status(v.id, p_start_date) not in ('stopped', 'completed')
  ) then
    return json_build_object('ok', false, 'error', 'conflicting_active_subscription');
  end if;

  insert into public.subscriptions (payee_id, payee_is_manual, created_by)
  values (v_src_sub.payee_id, v_src_sub.payee_is_manual, v_uid)
  returning id into v_new_sub_id;

  -- p_end_date (this call's own parameter) independently controls the new lineage's duration —
  -- has_no_end_date derives automatically (generated column); the source's own has_no_end_date is
  -- never copied, matching "Requires new start date and optional end date ... from caller".
  insert into public.subscription_versions (
    subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
    plan_start_date, plan_end_date, created_by
  ) values (
    v_new_sub_id, 1, p_start_date, v_src_version.monthly_price_ils, v_src_version.anchor_day,
    p_start_date, p_end_date, v_uid
  ) returning id into v_new_version_id;

  -- Copies price/allowances/plan settings only — never freezes, charges, coverage, or billing
  -- periods, which all stay with the original historical subscription (a brand-new subscriptions
  -- row means no FK from any of those tables could ever point at this new lineage anyway).
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
  select v_new_version_id, tier, weekly_limit
  from public.subscription_version_allowances where version_id = v_src_version.id;

  if p_start_date <= public._studio_today_date() then
    perform public.subscription_generate_or_correct_billing_period(
      v_new_sub_id, v_new_version_id, p_start_date,
      public.subscription_next_anchor_date(v_src_version.anchor_day, p_start_date),
      null, null
    );
  end if;

  return json_build_object('ok', true, 'subscription_id', v_new_sub_id, 'version_id', v_new_version_id);
end;
$$;

comment on function public.reactivate_subscription(uuid, date, date) is
  'Manager-only. Creates a brand-new subscriptions + subscription_versions + '
  'subscription_version_allowances lineage copying price/allowances/anchor from the source '
  'subscription''s most recent version. Never reopens the source lineage and never copies its '
  'freezes/charges/coverage/billing periods. First billing follows the normal create path.';

grant execute on function public.reactivate_subscription(uuid, date, date) to authenticated;
