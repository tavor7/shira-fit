-- Fix: subscription_reconcile_week() under-counted the weekly allowance already consumed by
-- live-but-not-yet-attended registrations, letting the reconcile pass and the registration-time
-- reservation (subscription_reserve_or_reject) independently grant coverage that together exceed
-- the subscription's weekly_limit.
--
-- Confirmed production example (read-only investigation, not altered by this migration): a
-- group-tier subscription with weekly_limit = 4 ended up with 5 `covered = true` rows for the same
-- week. Timeline:
--   1. Two future sessions were booked first (registered_at earliest). subscription_reserve_or_
--      reject correctly reserved 2 of the 4 slots for them (decided_by = 'registration').
--   2. Two more sessions were booked and attended later, also correctly reserved via
--      subscription_reserve_or_reject, filling the cap at 4/4.
--   3. A 5th session (registered after the others but attended before this migration's fix) had
--      its attended flag flip to true, firing the subscription_reconcile_on_registration_change
--      trigger -> subscription_reconcile_week().
--   4. subscription_reconcile_week()'s gather query only ever selected rows where
--      `(status = 'active' and attended is true) or (attended is false and charge_no_show)` —
--      i.e. only already-decided/chargeable rows. The two future, not-yet-attended registrations
--      from step 1 were invisible to it. It recomputed coverage for just the 3 attended rows it
--      *could* see, counting from zero, and marked all 3 of them covered=true — unaware that 2 of
--      the week's 4 slots were already spoken for. Total covered: 2 (step 1, untouched) + 3
--      (step 3's recompute) = 5, against a weekly_limit of 4.
--
-- Root cause: subscription_reconcile_week's gather predicate was narrower than the "live"
-- definition subscription_reserve_or_reject itself uses to count already-covered rows (see that
-- function's own comment, same migration file 20260924110000, around its `v_covered_count` query):
-- live = (manual participant row exists) OR (app registration status = 'active', REGARDLESS of
-- attended) OR (cancelled app registration with a charged_full_price cancellation). Reconcile
-- additionally required `attended is true` (or a charged no-show), which silently dropped
-- active-but-not-yet-attended registrations from both its running count AND its upserts.
--
-- Fix: broaden subscription_reconcile_week's gather predicate (both branches: app registrations
-- and manual participants) to the exact same "live" definition subscription_reserve_or_reject
-- already uses. This makes the two decision paths operate over the identical row set with the
-- identical registered_at/added_at, id ordering, so neither can independently grant more coverage
-- than weekly_limit for the same week/tier — the invariant the atomic reservation was designed to
-- hold, that the corrective reconcile pass was accidentally violating.
--
-- No change to: decision order (not_subscribed -> frozen -> tier_not_included ->
-- allowance_exceeded -> covered), the registered_at/added_at ASC, id ASC ordering, the advisory
-- lock, or any caller/trigger. This is a pure gather-predicate correction inside the existing
-- idempotent recompute; it deliberately does not touch historical coverage rows for any
-- subscription/week that hasn't been re-triggered since this migration (see the paired
-- backfill-decision note in supabase/tests/198_subscription_reconcile_live_set_tests.sh and
-- PROGRESS.md — re-running this corrected reconcile against the one known-affected production
-- week is a separate, explicitly-approved step, not part of this migration).

create or replace function public.subscription_reconcile_week(
  p_subscription_id uuid,
  p_week_start date,
  p_tier public.subscription_tier
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_lock_key bigint;
  v_covered_count int := 0;
  v_ctx public.subscription_effective_context_result;
  v_covered boolean;
  v_reason public.subscription_non_coverage_reason;
  r record;
begin
  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return;
  end if;

  v_lock_key := public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  if not v_payee_is_manual then
    -- Gather predicate widened to match subscription_reserve_or_reject's "live" definition:
    -- any active registration (regardless of attended — a future, not-yet-attended booking still
    -- legitimately holds its reserved slot) or a cancelled-but-charged-full-price registration.
    -- Previously this required attended = true (or a charged no-show), which dropped live future
    -- reservations from the count — the root cause fixed by this migration.
    for r in
      select reg.id as registration_id, reg.registered_at as created_at, s.session_date
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where reg.user_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          reg.status = 'active'
          or exists (
            select 1 from public.cancellations c
            where c.session_id = reg.session_id
              and c.user_id = reg.user_id
              and c.charged_full_price is true
          )
        )
      order by reg.registered_at asc, reg.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_ctx.weekly_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  else
    -- A removed manual participant is a hard DELETE (cascades to its coverage row via FK), so mere
    -- row existence already means "live" — no attended-based filter belongs here either, for the
    -- same reason as the app-registration branch above.
    for r in
      select m.id as registration_id, m.added_at as created_at, s.session_date
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where m.manual_participant_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
      order by m.added_at asc, m.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_ctx.weekly_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, null, r.registration_id,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  end if;
end;
$$;

comment on function public.subscription_reconcile_week(uuid, date, public.subscription_tier) is
  'Pure, idempotent recompute of coverage for one subscription/week/tier, ordered by '
  'registration.registered_at ASC, id ASC. Gather predicate matches subscription_reserve_or_'
  'reject''s live-registration definition exactly (any active registration regardless of '
  'attended status, or a charged-full-price cancellation; any existing manual-participant row) '
  'so the two decision paths can never independently over-allocate the weekly allowance. '
  'Fixed 2026-10-29 (20261029210000) — previously required attended = true, which dropped live '
  'future reservations from the count. Safe to call twice.';
