-- Subscription stop/delete: handle future registrations that outlive the subscription.
--
-- Problem: stopping or deleting a subscription could leave an athlete still registered for sessions
-- scheduled after the subscription ends, still marked `covered = true` in
-- subscription_registration_coverage (set at registration time, never revisited for
-- not-yet-occurred sessions -- subscription_reconcile_week only ever looks at ALREADY-occurred
-- registrations: attended, or a charged late cancellation; see its WHERE clauses). Left alone, those
-- future sessions would silently stay "free" (subscription-covered) even though the subscription no
-- longer exists on that date -- neither charged correctly nor flagged for the manager to handle.
--
-- Fix: a manager stopping or deleting a subscription with such future registrations must now choose,
-- per the SAME preview/confirm pattern already used by edit/freeze/stop (subscription_compute_impact):
--   'remove'                -- take the athlete off those future sessions (manager_remove_athlete /
--                              remove_manual_participant_from_session -- cancels the registration /
--                              deletes the manual-participant row, exactly as a manager removing
--                              someone from any other session already does; writes registration_history
--                              for app athletes same as that existing path)
--   'charge_regular_price'  -- keep the registrations, but flip their coverage row to
--                              covered = false, non_coverage_reason = 'subscription_ended'. This
--                              creates NO immediate charge -- it only stops the registration from
--                              being treated as subscription-covered, so the EXISTING per-session
--                              billing mechanism (_period_merged_athlete_finance's
--                              `case when cov.covered then 0 else session_billing_price_ils(...) end`)
--                              charges it at the regular session price once the session is actually
--                              attended, exactly like any other non-subscription registration.
--
-- Deployment shape (distinct from the first draft of this migration): rather than replacing
-- stop_subscription(uuid,date,boolean) / delete_subscription(uuid) in place -- which requires an
-- explicit DROP FUNCTION first, since CREATE OR REPLACE cannot change a function's parameter list --
-- this migration leaves BOTH existing functions completely untouched (not a single statement here
-- references or alters them) and adds the future-registration-aware flow as two BRAND NEW, separately
-- named RPCs: stop_subscription_with_future_registrations and delete_subscription_with_future_
-- registrations. Neither name previously existed, so every CREATE OR REPLACE below is a pure create --
-- there is no DROP FUNCTION anywhere in this file, no possibility of an ambiguous overload (the names
-- don't collide), and the original two RPCs keep serving exactly the callers and behavior they always
-- have, unmodified. The mobile client switches to calling the new names (separate, non-deployed-yet
-- change); until it does, the app keeps working exactly as before via the old entry points. A future
-- cleanup migration can retire the old names once no client calls them anymore -- out of scope here.
--
-- Second-pass hardening (this version), three issues found in review:
--
-- (1) SAME-DAY ALREADY-OCCURRED SESSIONS. `session_date >= cutoff` alone is not enough: cutoff is a
--     DATE (the stop date, or "today" for delete), so a session scheduled EARLIER TODAY that the
--     athlete already attended has session_date = cutoff and would match `>=`, even though it has
--     already happened. Fixed by additionally requiring NOT public._session_has_ended(ts) (the
--     codebase's existing canonical "has this session's studio-timezone wall-clock window passed"
--     check, already used by block_registration_after_session_end and others) in both the preview and
--     the resolve queries, joined to public.training_sessions. This is strictly more conservative than
--     `session_date >= cutoff` alone: it also correctly excludes a same-day session that hasn't
--     started yet from being wrongly excluded (its coverage is still legitimately future), while
--     excluding one that has already ended regardless of whether attendance was marked yet.
--
-- (2) PREVIEW/CONFIRM STALENESS. The confirm step re-queries subscription_future_registrations_impact
--     fresh (by design, for correctness against concurrent cancellations -- see the original
--     "Preview/confirm consistency" note below) rather than trusting the client's remembered preview.
--     But re-querying fresh ALSO means a registration added for a future session AFTER the manager's
--     preview (e.g. the athlete self-registers via the app while the manager is still deciding) would
--     be silently swept into the SAME resolution the manager approved, without them ever having seen
--     it. Fixed: both stop_subscription_with_future_registrations and
--     delete_subscription_with_future_registrations now take p_expected_future_registration_ids /
--     p_expected_future_manual_participant_ids (the exact ids the client read out of ITS preview
--     response). When actually resolving (p_future_registration_action is not null and there is
--     something to resolve), the freshly-recomputed set must be a SUBSET of the expected ids -- a
--     previously-previewed row that disappeared (cancelled concurrently) is fine and simply isn't
--     resolved; one that's NOT in the expected set (new since preview) aborts the ENTIRE call with
--     error future_registrations_changed before anything is mutated, forcing a fresh preview. Omitting
--     the expected-id arrays entirely while something would be resolved is refused up front
--     (future_registrations_expectation_required) -- the check cannot be silently skipped by a client
--     that forgets to pass it.
--
-- (3) ATOMICITY IN THE SQL EDITOR. Every statement here (CREATE OR REPLACE FUNCTION, COMMENT, REVOKE,
--     GRANT, DO) is transaction-safe (no CONCURRENTLY, no VACUUM, no bare ALTER TYPE ... ADD VALUE --
--     that lives in the prior, separate 20261026090258 migration specifically because a new enum
--     value cannot be used in the same transaction that adds it). Postgres's simple-query protocol
--     already treats a single multi-statement submission as an implicit transaction, but to remove any
--     ambiguity about how a given SQL Editor build batches/splits statements, this file now wraps
--     itself in an explicit BEGIN/COMMIT: a failure anywhere (including the closing self-check) rolls
--     back every CREATE/REVOKE/GRANT in the file, leaving the schema exactly as it was before the run.
--
-- Scope and safety (otherwise unchanged from the first draft):
--   - Only registrations for sessions on/after the subscription's termination date, AND not yet ended,
--     are touched (session_date >= cutoff and not _session_has_ended(ts) -- cutoff = the stop date for
--     stop_subscription_with_future_registrations, "today" for delete_subscription_with_future_
--     registrations, matching subscription_effective_context's own
--     `stopped_effective_date > p_session_date` in-window test: the termination date itself is already
--     NOT covered, so session_date >= cutoff is precisely "no longer covered" -- refined further by (1)
--     above to exclude same-day sessions that already happened).
--   - Only rows with covered = true are touched -- a session already excluded for some other reason
--     (frozen, allowance exceeded, ...) is left exactly as it was.
--   - No attended session, no payment, no subscription_charges/subscription_billing_periods/
--     subscription_versions row is read or written by either resolution branch -- this is purely a
--     session_registrations / session_manual_participants / subscription_registration_coverage
--     operation, and now provably excludes anything _session_has_ended() already considers over.
--   - Concurrency: resolution runs inside the same transaction as the stop/delete it's part of, after
--     the existing subscription_admin_lock_key advisory lock (serializing against another stop/freeze/
--     edit/delete on the SAME subscription, old or new entry point alike -- they share the same lock
--     key function), and additionally re-selects and locks (FOR UPDATE) each affected coverage/
--     registration/manual-participant row at confirm time. If a registration was concurrently
--     cancelled or attended between preview and confirm, it is silently skipped (status <> 'active' or
--     _session_has_ended() now true at lock time) -- matching this codebase's existing concurrency
--     discipline elsewhere (e.g. _guard_delete_receipted_session's FOR UPDATE loop over
--     session_registrations before acting). A registration ADDED between preview and confirm is caught
--     by (2) above instead, since it is never in the expected-id set.

begin;

-- Read-only preview: every future (session_date >= p_cutoff_date, session not yet ended), currently-
-- covered registration for this subscription, with its tier and the regular price it would carry if
-- resolved as 'charge_regular_price' (informational only -- never charged here).
create or replace function public.subscription_future_registrations_impact(
  p_subscription_id uuid,
  p_cutoff_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'registration_id', cov.registration_id,
    'manual_participant_id', cov.manual_participant_id,
    'session_date', cov.session_date,
    'tier', cov.tier,
    'regular_price_ils', public.session_billing_price_ils(
      coalesce(sr.session_id, smp.session_id),
      sr.user_id,
      cov.manual_participant_id
    )
  ) order by cov.session_date), '[]'::jsonb)
  from public.subscription_registration_coverage cov
  left join public.session_registrations sr
    on sr.id = cov.registration_id and sr.status = 'active'
  left join public.session_manual_participants smp
    on smp.id = cov.manual_participant_id
  left join public.training_sessions ts
    on ts.id = coalesce(sr.session_id, smp.session_id)
  where cov.subscription_id = p_subscription_id
    and cov.covered = true
    and cov.session_date >= p_cutoff_date
    -- An app-athlete registration that was already cancelled some other way is no longer "a future
    -- registration that outlives the subscription" -- nothing to resolve for it.
    and (cov.registration_id is null or sr.id is not null)
    -- (1) Exclude a same-day session that has already happened, even though session_date = cutoff
    -- satisfies the date-only comparison above. A coverage row whose session can't be found at all
    -- (ts is null) is excluded too -- _session_has_ended(null-row) evaluates to NULL, which WHERE
    -- treats as not-satisfied, the conservative choice for data we can't verify.
    and not public._session_has_ended(ts);
$$;

comment on function public.subscription_future_registrations_impact(uuid, date) is
  'Read-only preview: future (session_date >= p_cutoff_date AND not yet ended -- see _session_has_ended), '
  'currently-covered registrations for a subscription about to be stopped/deleted, with the regular '
  'price each would carry if resolved as "charge_regular_price". No data is written. Internal-only, '
  'called from stop_subscription_with_future_registrations / delete_subscription_with_future_'
  'registrations.';

revoke execute on function public.subscription_future_registrations_impact(uuid, date) from public, anon, authenticated;

-- Confirm-time resolution: locks and resolves every future-covered, not-yet-ended registration per
-- p_action. Returns the number of registrations actually resolved (may be less than the preview count
-- if something changed concurrently between preview and confirm). Callers (both public entry points
-- below) have already verified the resolved set is a subset of what the manager was shown -- this
-- function itself re-filters by the same _session_has_ended guard as the preview, independently.
create or replace function public._subscription_resolve_future_registrations(
  p_subscription_id uuid,
  p_cutoff_date date,
  p_action text -- 'remove' | 'charge_regular_price'
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  r record;
begin
  if p_action not in ('remove', 'charge_regular_price') then
    raise exception 'invalid_future_registration_action';
  end if;

  for r in
    select cov.id as cov_id, sr.session_id, sr.user_id
    from public.subscription_registration_coverage cov
    join public.session_registrations sr on sr.id = cov.registration_id
    join public.training_sessions ts on ts.id = sr.session_id
    where cov.subscription_id = p_subscription_id
      and cov.covered = true
      and cov.session_date >= p_cutoff_date
      and cov.registration_id is not null
      and sr.status = 'active'
      and not public._session_has_ended(ts)
    for update of cov, sr
  loop
    if p_action = 'remove' then
      perform public.manager_remove_athlete(r.session_id, r.user_id);
      -- The registration row survives as 'cancelled' (manager_remove_athlete never deletes it, for
      -- registration_history's sake) -- the coverage row no longer describes anything live, so it is
      -- removed too (now safe: 20261026160000 unguarded this table from hard DELETE). Neither the
      -- registration nor any attendance/payment row is touched.
      delete from public.subscription_registration_coverage where id = r.cov_id;
    else
      update public.subscription_registration_coverage
      set covered = false,
          non_coverage_reason = 'subscription_ended',
          decided_at = now(),
          decided_by = 'reconcile'
      where id = r.cov_id;
    end if;
    v_count := v_count + 1;
  end loop;

  for r in
    select cov.id as cov_id, smp.session_id, smp.manual_participant_id as mp_id
    from public.subscription_registration_coverage cov
    join public.session_manual_participants smp on smp.id = cov.manual_participant_id
    join public.training_sessions ts on ts.id = smp.session_id
    where cov.subscription_id = p_subscription_id
      and cov.covered = true
      and cov.session_date >= p_cutoff_date
      and cov.manual_participant_id is not null
      and not public._session_has_ended(ts)
    for update of cov, smp
  loop
    if p_action = 'remove' then
      perform public.remove_manual_participant_from_session(r.session_id, r.mp_id);
      -- remove_manual_participant_from_session hard-deletes the session_manual_participants row,
      -- which cascades the coverage row automatically (20261026160000) -- explicit delete as a
      -- harmless backstop in case that ever changes.
      delete from public.subscription_registration_coverage where id = r.cov_id;
    else
      update public.subscription_registration_coverage
      set covered = false,
          non_coverage_reason = 'subscription_ended',
          decided_at = now(),
          decided_by = 'reconcile'
      where id = r.cov_id;
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public._subscription_resolve_future_registrations(uuid, date, text) is
  'Confirm-time only. Locks (FOR UPDATE) and resolves every future-covered, not-yet-ended (see '
  '_session_has_ended) registration for a subscription being stopped/deleted: ''remove'' cancels/'
  'removes the registration (same RPCs a manager already uses to remove anyone from a session); '
  '''charge_regular_price'' flips the coverage row to covered=false, '
  'non_coverage_reason=''subscription_ended'' -- no charge is created here, the existing per-session '
  'billing path charges it at the regular price once attended. Never touches a past/occurred session, '
  'a payment, or any subscription_charges/billing_periods/versions row. Internal-only, called from '
  'stop_subscription_with_future_registrations / delete_subscription_with_future_registrations inside '
  'their subscription_admin_lock_key-guarded transaction, after they have verified the resolved set '
  'against what the manager was shown in preview.';

revoke execute on function public._subscription_resolve_future_registrations(uuid, date, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- stop_subscription_with_future_registrations: a NEW, separately-named RPC (stop_subscription(uuid,
-- date, boolean) is untouched by this file). Body is stop_subscription's full logic
-- (20261013110000) plus the future-registrations preview/confirm/resolve step.
-- ---------------------------------------------------------------------------------------------------
create or replace function public.stop_subscription_with_future_registrations(
  p_subscription_id uuid,
  p_stop_date date,
  p_confirmed boolean default false,
  p_future_registration_action text default null, -- 'remove' | 'charge_regular_price' | null
  p_expected_future_registration_ids uuid[] default null,
  p_expected_future_manual_participant_ids uuid[] default null
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
  v_future_impact jsonb;
  v_future_resolved int := 0;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
  end if;
  if p_future_registration_action is not null and p_future_registration_action not in ('remove', 'charge_regular_price') then
    return json_build_object('ok', false, 'error', 'invalid_future_registration_action');
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

  v_future_impact := public.subscription_future_registrations_impact(p_subscription_id, p_stop_date);

  if (coalesce((v_impact->>'count')::int, 0) > 0 or jsonb_array_length(v_future_impact) > 0)
     and not coalesce(p_confirmed, false) then
    return json_build_object(
      'ok', true, 'action', 'preview', 'impact', v_impact,
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  if jsonb_array_length(v_future_impact) > 0 and p_future_registration_action is null then
    return json_build_object(
      'ok', false, 'error', 'future_registration_action_required',
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  -- (2) Preview/confirm staleness guard. Only relevant when we're actually about to resolve
  -- something; a null action with zero future rows never reaches here with anything to check.
  if p_future_registration_action is not null and jsonb_array_length(v_future_impact) > 0 then
    if p_expected_future_registration_ids is null or p_expected_future_manual_participant_ids is null then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_expectation_required',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(v_future_impact) as x(registration_id uuid, manual_participant_id uuid)
      where (x.registration_id is not null and x.registration_id <> all (p_expected_future_registration_ids))
         or (x.manual_participant_id is not null and x.manual_participant_id <> all (p_expected_future_manual_participant_ids))
    ) then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_changed',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;
  end if;

  -- Idempotency key includes both which entry point applied the stop and the chosen future-
  -- registration action (same discipline as edit_subscription_version's payload-inclusive key): a
  -- retry with the SAME action converges; a different action for the same subscription/stop_date is a
  -- genuinely different operation. Deliberately namespaced ('stopv2') separately from the plain
  -- stop_subscription entry point's key -- the two share subscription_admin_lock_key (so they can
  -- never race each other) but are tracked as independent idempotency lineages; the underlying
  -- mutations (stopped_effective_date update, billing correction) are themselves safe to re-apply with
  -- the same effective values (guarded by `is distinct from` / amount-equality checks), so this is a
  -- transitional-period bookkeeping nuance, not a correctness or financial-integrity risk.
  v_source_id := md5(
    p_subscription_id::text || '|stopv2|' || p_stop_date::text || '|' ||
    coalesce(p_future_registration_action, 'none')
  )::uuid;

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

  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end > p_stop_date
    order by bp.raw_period_start asc
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_source_id, 'stop_proration'
    );
  end loop;

  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, p_stop_date, p_future_registration_action
    );
  end if;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object(
    'ok', true, 'action', 'applied', 'impact', v_impact,
    'future_registrations_resolved', v_future_resolved
  );
end;
$$;

comment on function public.stop_subscription_with_future_registrations(uuid, date, boolean, text, uuid[], uuid[]) is
  'Manager-only. Same as stop_subscription(uuid,date,boolean), plus: when future (session_date >= '
  'p_stop_date, not yet ended) subscription-covered registrations exist, the preview response also '
  'lists them; the confirmed call requires p_future_registration_action (''remove'' or '
  '''charge_regular_price'') plus p_expected_future_registration_ids / '
  'p_expected_future_manual_participant_ids (the ids the caller read from its own preview) to resolve '
  'them -- resolving a registration not in that expected set is refused (future_registrations_changed) '
  'rather than silently included. See _subscription_resolve_future_registrations. The plain '
  'stop_subscription(uuid,date,boolean) RPC is untouched and still callable -- this is an additional '
  'entry point, not a replacement.';

grant execute on function public.stop_subscription_with_future_registrations(uuid, date, boolean, text, uuid[], uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- delete_subscription_with_future_registrations: a NEW, separately-named RPC (delete_subscription(uuid)
-- is untouched by this file). Body is delete_subscription's full logic (20261026100000) plus the
-- future-registrations preview/confirm/resolve step.
-- ---------------------------------------------------------------------------------------------------
create or replace function public.delete_subscription_with_future_registrations(
  p_subscription_id uuid,
  p_future_registration_action text default null, -- 'remove' | 'charge_regular_price' | null
  p_confirmed boolean default false,
  p_expected_future_registration_ids uuid[] default null,
  p_expected_future_manual_participant_ids uuid[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_has_payment boolean;
  v_source_id uuid;
  v_reversed_count int := 0;
  v_reversed_total numeric(12, 2) := 0;
  v_cutoff date;
  v_future_impact jsonb;
  v_future_resolved int := 0;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_future_registration_action is not null and p_future_registration_action not in ('remove', 'charge_regular_price') then
    return json_build_object('ok', false, 'error', 'invalid_future_registration_action');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select deleted_at into v_deleted_at
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Idempotent no-op: never re-check payments or re-reverse charges on a repeated call.
  if v_deleted_at is not null then
    return json_build_object('ok', true, 'action', 'already_deleted');
  end if;

  -- The owner-approved rule: ANY valid (unreversed) payment -- including a partial one -- blocks
  -- deletion outright. Nothing is modified when this fires: no charge touched, no payment touched,
  -- the subscription itself untouched. The caller should offer stop instead.
  select exists (
    select 1 from public.athlete_account_payments a
    where a.source_subscription_id = p_subscription_id
      and a.reversed_at is null
  ) into v_has_payment;

  if v_has_payment then
    return json_build_object('ok', false, 'error', 'subscription_has_payments');
  end if;

  -- Deletion is immediate (unlike a scheduled stop date): the cutoff for "future" is today.
  v_cutoff := public._studio_today_date();
  v_future_impact := public.subscription_future_registrations_impact(p_subscription_id, v_cutoff);

  if jsonb_array_length(v_future_impact) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object(
      'ok', true, 'action', 'preview',
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  if jsonb_array_length(v_future_impact) > 0 and p_future_registration_action is null then
    return json_build_object(
      'ok', false, 'error', 'future_registration_action_required',
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  -- (2) Preview/confirm staleness guard -- see stop_subscription_with_future_registrations for the
  -- full rationale. Runs before anything is mutated (including the payment-block/charge-reversal
  -- steps below), so a mismatch aborts the whole deletion, not just the future-registration part.
  if p_future_registration_action is not null and jsonb_array_length(v_future_impact) > 0 then
    if p_expected_future_registration_ids is null or p_expected_future_manual_participant_ids is null then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_expectation_required',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(v_future_impact) as x(registration_id uuid, manual_participant_id uuid)
      where (x.registration_id is not null and x.registration_id <> all (p_expected_future_registration_ids))
         or (x.manual_participant_id is not null and x.manual_participant_id <> all (p_expected_future_manual_participant_ids))
    ) then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_changed',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;
  end if;

  v_source_id := gen_random_uuid();

  -- Reverse every currently-effective charge (any charge_type -- recurring, proration,
  -- freeze_credit, stop_proration, edit_correction -- whichever haven't already been reversed by
  -- an earlier stop/freeze/edit correction) so this subscription contributes exactly zero to
  -- outstanding debt everywhere it's read from (manager_subscription_overview_stats,
  -- _period_merged_athlete_finance, get_subscription_detail). The original charge rows are never
  -- altered -- only a new `reversal` row is appended per charge, linked via `reverses`, same
  -- append-only discipline as every other correction path.
  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.subscription_id = p_subscription_id
      and c.charge_type <> 'reversal'
      and not exists (
        select 1 from public.subscription_charges rv
        where rv.charge_type = 'reversal' and rv.reverses = c.id
      )
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id, v_source_id
    );
    v_reversed_count := v_reversed_count + 1;
    v_reversed_total := v_reversed_total + r.amount_ils;
  end loop;

  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, v_cutoff, p_future_registration_action
    );
  end if;

  return json_build_object(
    'ok', true, 'action', 'tombstoned',
    'reversed_charge_count', v_reversed_count,
    'reversed_total_ils', v_reversed_total,
    'future_registrations_resolved', v_future_resolved
  );
end;
$$;

comment on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) is
  'Manager-only. Same as delete_subscription(uuid), plus: blocks deletion outright (error '
  'subscription_has_payments) if any unreversed payment is attributed to this subscription; when '
  'future (session_date >= today, not yet ended) subscription-covered registrations exist, the first '
  'call (p_confirmed=false) returns an action=preview listing them instead of deleting anything, and '
  'the confirmed call requires p_future_registration_action (''remove'' or ''charge_regular_price'') '
  'plus p_expected_future_registration_ids / p_expected_future_manual_participant_ids (the ids the '
  'caller read from its own preview) to resolve them -- resolving a registration not in that expected '
  'set is refused (future_registrations_changed) rather than silently included. See '
  '_subscription_resolve_future_registrations. Otherwise reverses every remaining effective '
  'subscription_charges row (append-only, via a new reversal row per charge) so the subscription '
  'contributes zero outstanding debt, then tombstones (deleted_at) -- never a hard DELETE. Idempotent: '
  'a repeated call on an already-deleted subscription is a no-op and never re-reverses anything. The '
  'plain delete_subscription(uuid) RPC is untouched and still callable -- this is an additional entry '
  'point, not a replacement.';

grant execute on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) to authenticated;

-- Self-check: new internal helpers stay client-unreachable; both new public entry points are callable;
-- the two ORIGINAL entry points are untouched (still exist with their exact original signature).
do $$
begin
  if has_function_privilege('authenticated', 'public.subscription_future_registrations_impact(uuid,date)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.subscription_future_registrations_impact(uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: subscription_future_registrations_impact must stay client-unreachable';
  end if;
  if has_function_privilege('authenticated', 'public._subscription_resolve_future_registrations(uuid,date,text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._subscription_resolve_future_registrations(uuid,date,text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _subscription_resolve_future_registrations must stay client-unreachable';
  end if;
  if not has_function_privilege('authenticated', 'public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: stop_subscription_with_future_registrations missing EXECUTE for authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: delete_subscription_with_future_registrations missing EXECUTE for authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.stop_subscription(uuid,date,boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: the ORIGINAL stop_subscription(uuid,date,boolean) must remain untouched and callable';
  end if;
  if not has_function_privilege('authenticated', 'public.delete_subscription(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: the ORIGINAL delete_subscription(uuid) must remain untouched and callable';
  end if;
end $$;

commit;
