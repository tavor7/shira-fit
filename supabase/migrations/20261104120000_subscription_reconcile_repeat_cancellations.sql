-- subscription_reconcile_week failed with "more than one row returned by a subquery used as an expression" for anyone who
-- has cancelled the same session twice. Each cancel, rebook, cancel again leaves its own row in public.cancellations, so
-- several rows for one person and session are valid history, not bad data. A unique index would be wrong.
--
-- The scalar subquery read one penalty per registration. It runs for all of the person's registrations before the week filter,
-- so one such session from any date broke reconcile for every week, and with it everything that triggers it: attendance,
-- cancelling, session moves, and subscription stop, freeze and edit.
--
-- What was collected for a session is the sum of the penalties of all its cancellations, which is how Reports already count them,
-- since each row is a separate event with its own receipt. Only that one expression changes.
--
-- The body below is otherwise the production definition (20261104105000). Grants are unchanged by create or replace.

CREATE OR REPLACE FUNCTION public.subscription_reconcile_week(p_subscription_id uuid, p_week_start date, p_tier subscription_tier)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_limit int;
  v_covered_count int := 0;
  v_ctx public.subscription_effective_context_result;
  v_covered boolean;
  v_reason public.subscription_non_coverage_reason;
  v_released_from_covered boolean;
  v_today date := public._studio_today_date();
  r record;
begin
  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier));

  v_limit := public.subscription_effective_weekly_limit(v_payee_id, v_payee_is_manual, p_tier, p_week_start);

  for r in
    select g.*, ts.session_date, public._session_has_ended(ts) as ended, h.held,
           coalesce(cov.released_from_covered, false) as released_from_covered,
           cov.id as coverage_id, cov.subscription_id as was_subscription_id,
           exists (select 1 from public.subscription_deletion_corrections k
                   where k.coverage_id = cov.id and k.status in ('pending', 'awaiting_accounting', 'kept_covered')) as correction_hold, cov.covered as was_covered, cov.non_coverage_reason as was_reason,
           public._subscription_slot_state(g.status, g.attended, g.charge_no_show, g.charged_cancellation, public._session_has_ended(ts)) as state
    from (
      select reg.id as registration_id, null::uuid as manual_row_id, reg.session_id, reg.registered_at as created_at,
             reg.status, reg.attended, reg.charge_no_show,
             exists (select 1 from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id and c.charged_full_price is true) as charged_cancellation,
             coalesce(reg.amount_paid, 0) + coalesce((select sum(c.penalty_collected_ils) from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id), 0) as collected
      from public.session_registrations reg
      where not v_payee_is_manual and reg.user_id = v_payee_id
      union all
      select null, m.id, m.session_id, m.added_at, null, m.attended, m.charge_no_show, false, coalesce(m.amount_paid, 0)
      from public.session_manual_participants m
      where v_payee_is_manual and m.manual_participant_id = v_payee_id
    ) g
    join public.training_sessions ts on ts.id = g.session_id
    left join public.subscription_registration_coverage cov
      on cov.registration_id = g.registration_id or cov.manual_participant_id = g.manual_row_id
    cross join lateral (
      -- Held a covered slot, and the session is over (or began on an earlier date and is crossing midnight).
      select (coalesce(cov.covered, false) or coalesce(cov.released_from_covered, false))
             and (public._session_has_ended(ts) or ts.session_date < v_today)
             and public._subscription_slot_state(g.status, g.attended, g.charge_no_show, g.charged_cancellation, public._session_has_ended(ts))
                 in ('attended', 'penalty', 'unmarked', 'reserved') as held
    ) h
    where ts.session_date between p_week_start and p_week_start + 6
      and public.subscription_tier_for_capacity(ts.max_participants) = p_tier
    -- Completed sessions count first, by date, so what is left for future bookings does not depend on booking order.
    order by case when h.held then 0 else 1 end,
             case when h.held then ts.session_date end,
             case when h.held then ts.start_time end,
             g.created_at asc, coalesce(g.registration_id, g.manual_row_id) asc
  loop
    -- A cancelled booking holds nothing and is left as recorded.
    continue when r.state = 'cancelled';
    -- History stays as it is: coverage is never created for a session that already ended.
    continue when r.coverage_id is null and r.ended;
    -- A receipt-locked session awaiting a decision or accounting review, or kept by a decision, changes only through that workflow.
    continue when r.correction_hold;

    v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);
    v_released_from_covered := false;

    if r.was_reason = 'subscription_deleted' and (r.ended or v_ctx.subscription_id is null) then
      -- Deleting a subscription moved this session to regular price; attendance edits must not undo that.
      v_covered := false;
      v_reason := 'subscription_deleted';
    elsif r.state = 'released' then
      v_covered := false;
      v_reason := 'no_show_released';
      v_released_from_covered := coalesce(r.was_covered, false) or r.released_from_covered;
    elsif r.held and r.ended and (exists (
      select 1 from public.subscription_versions sv
      where sv.subscription_id = r.was_subscription_id and sv.stopped_effective_date = r.session_date
    ) or exists (
      select 1 from public.subscription_freezes f
      where f.subscription_id = r.was_subscription_id and f.cancelled_at is null and f.freeze_from = r.session_date
    ) or exists (
      select 1 from public.subscription_versions sv
      where sv.subscription_id = r.was_subscription_id and sv.version_no > 1 and sv.effective_from = r.session_date
    )) then
      -- A session on the day a stop, freeze or edit takes effect that had already taken place stays as it was. Had the change
      -- come first, the reconcile it ran would already have taken the coverage away.
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    elsif v_ctx.subscription_id is null or not v_ctx.in_window then
      v_covered := false;
      v_reason := case when r.was_reason = 'subscription_ended' then 'subscription_ended'::public.subscription_non_coverage_reason
                       else 'not_subscribed'::public.subscription_non_coverage_reason end;
    elsif v_ctx.is_frozen then
      v_covered := false;
      v_reason := 'frozen';
    elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
      v_covered := false;
      v_reason := 'tier_not_included';
    elsif coalesce(r.was_covered, false) is false and r.was_reason = 'allowance_exceeded' and r.state = 'penalty' then
      -- A penalty charged at the regular price stays that way: another booking being cancelled does not make it free.
      v_covered := false;
      v_reason := 'allowance_exceeded';
    elsif r.held and v_covered_count < public._subscription_session_entitlement(v_payee_id, v_payee_is_manual, p_tier, p_week_start, r.session_date) then
      -- Valid coverage on a completed session: a change that took effect after it does not take this away.
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    elsif v_covered_count >= v_limit then
      v_covered := false;
      v_reason := 'allowance_exceeded';
    elsif coalesce(r.was_covered, false) is false and r.collected > 0 then
      -- Money was already taken for this session at the regular price. A slot freeing up later must not silently turn
      -- that into an unexplained credit.
      v_covered := false;
      v_reason := 'paid_at_regular_price';
    else
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    end if;

    if r.registration_id is not null then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, released_from_covered, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, v_released_from_covered, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        released_from_covered = excluded.released_from_covered,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason,
             public.subscription_registration_coverage.released_from_covered)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason, excluded.released_from_covered);
    else
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, released_from_covered, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, null, r.manual_row_id,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, v_released_from_covered, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        released_from_covered = excluded.released_from_covered,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason,
             public.subscription_registration_coverage.released_from_covered)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason, excluded.released_from_covered);
    end if;
  end loop;
end;
$function$;
