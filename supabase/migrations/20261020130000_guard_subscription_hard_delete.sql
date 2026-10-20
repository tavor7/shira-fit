-- Financial integrity: a subscription and its historical financial records must never be hard-deleted.
--
-- Investigated first (read in full): delete_subscription never hard-deletes -- it only sets `deleted_at` on
-- the subscriptions row (a tombstone); every read path (subscription_effective_context,
-- generate_due_subscription_charges, subscription_version_display_status, ...) already filters
-- `deleted_at is null`, so a tombstoned subscription simply stops accruing future charges/benefits while its
-- entire history stays queryable forever. stop_subscription / freeze_subscription / edit_subscription_version /
-- reactivate_subscription all follow the same append-only discipline: corrections are a `reversal` row plus a
-- new charge in subscription_charges (never an UPDATE or DELETE of a posted charge), and edits either mutate an
-- UNREFERENCED current version in place or close it and insert a new one (never delete a referenced version).
-- Grepped every migration in the repository for a literal `delete from public.subscriptions`,
-- `...subscription_versions`, `...subscription_freezes`, `...subscription_billing_periods`,
-- `...subscription_charges`, `...subscription_registration_coverage`, `...subscription_impact_events` or
-- `...subscription_impact_event_registrations` -- there are zero hits anywhere in this repository's history.
-- The one legitimate exception is `subscription_version_allowances` (edit_subscription_version
-- delete-and-reinsert's the per-tier weekly-limit rows when mutating an unreferenced version in place) -- that
-- table is deliberately NOT included below, since blocking it would break ordinary price/allowance edits.
--
-- The gap this migration closes: RLS on every one of these 8 tables is `FOR ALL USING (is_manager(auth.uid()))`
-- (verified by reading pg_policies against production) -- meaning a manager can `DELETE` any of these rows
-- directly over PostgREST, completely bypassing delete_subscription's tombstone-only design. Nothing in the
-- RPC layer prevents this; only the UI never offering such a button does. This migration closes it at the only
-- layer that can't be bypassed by a different client, a different screen, or a future RPC that forgets to
-- re-derive this rule: a BEFORE DELETE row trigger on each table that unconditionally refuses, since the
-- established architecture already has zero legitimate reason to ever hard-delete any of these rows, with or
-- without a receipt.
--
-- What this migration deliberately does NOT do, and why (see also the final report, Part D):
--   - It does NOT attempt to determine whether a specific issued receipt is "for" a specific subscription.
--     athlete_account_payments has no reliable link to a subscription today (no subscription_charge_id, no
--     source_subscription_id -- that column is PLANNED for the separate subscription-payment feature and does
--     not exist yet). Inferring the link from payee identity, payment amount or date proximity would produce
--     false positives (an athlete's unrelated session payment or account payment would incorrectly "protect" a
--     subscription that has nothing to do with it) and is explicitly out of scope for this release.
--   - It therefore cannot and does not implement "a subscription WITH A LINKED ISSUED RECEIPT specifically
--     cannot be deleted" -- that requires the future source_subscription_id column plus a receipt-aware guard
--     analogous to _guard_delete_receipted_session, and is called out as an explicit dependency below and in
--     the final report. What it does implement is narrower but immediately valuable: a subscription's
--     historical financial records (every charge, correction, reversal, version, freeze and billing period it
--     ever had) can never be physically destroyed by ANY path, receipt or no receipt -- which is what
--     delete_subscription already guarantees today; this migration only makes sure nothing else can silently
--     bypass that guarantee.
--   - It does NOT change delete_subscription, stop_subscription, freeze_subscription, edit_subscription_version
--     or reactivate_subscription in any way -- none of them ever issues a hard DELETE on these tables, so this
--     migration has zero effect on any of them (see the grep evidence above); all remain fully available
--     exactly as before, including a future cancellation, stopping future renewals, valid freezes and permitted
--     price changes.

create or replace function public._reject_subscription_hard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'subscription_record_immutable'
    using errcode = 'P0001',
          detail = format(
            'Rows in %I are append-only financial history and cannot be hard-deleted. Use the existing subscription RPCs (delete_subscription, stop_subscription, freeze_subscription, edit_subscription_version) instead.',
            tg_table_name
          );
  return old;
end;
$$;

comment on function public._reject_subscription_hard_delete() is
  'Unconditionally refuses a hard DELETE on an append-only subscription/financial-history table, regardless of caller (including managers via direct PostgREST). No legitimate code path in this codebase ever deletes from these tables -- see migration header for the verification.';

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'subscriptions',
    'subscription_versions',
    'subscription_freezes',
    'subscription_billing_periods',
    'subscription_charges',
    'subscription_registration_coverage',
    'subscription_impact_events',
    'subscription_impact_event_registrations'
  ]
  loop
    execute format('drop trigger if exists %I_hard_delete_guard on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_hard_delete_guard before delete on public.%I for each row execute function public._reject_subscription_hard_delete()',
      v_table, v_table
    );
  end loop;
end $$;

-- Trigger function is not an RPC.
revoke execute on function public._reject_subscription_hard_delete() from public, anon, authenticated;

-- Self-check: every listed table has the guard; the legitimately-mutable allowances table does not; a plain
-- DELETE against a scratch row in each guarded table is refused.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'subscriptions', 'subscription_versions', 'subscription_freezes', 'subscription_billing_periods',
    'subscription_charges', 'subscription_registration_coverage', 'subscription_impact_events',
    'subscription_impact_event_registrations'
  ]
  loop
    if not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = v_table and t.tgname = v_table || '_hard_delete_guard' and not t.tgisinternal
    ) then
      raise exception 'self-check: % is missing its hard-delete guard', v_table;
    end if;
  end loop;
  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'subscription_version_allowances' and t.tgname = 'subscription_version_allowances_hard_delete_guard'
  ) then
    raise exception 'self-check: subscription_version_allowances must stay deletable (edit_subscription_version depends on it)';
  end if;
  if has_function_privilege('authenticated', 'public._reject_subscription_hard_delete()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._reject_subscription_hard_delete()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _reject_subscription_hard_delete must stay client-unreachable as a direct call';
  end if;
end $$;
