-- Fix: deleting a session with a subscription-covered registration fails with
-- "subscription_record_immutable". Reproduced in production: the 2026-10-26 08:30 session could not
-- be deleted.
--
-- Root cause: 20261023130000_guard_subscription_hard_delete.sql added a BEFORE DELETE trigger that
-- unconditionally refuses a hard DELETE on 8 tables, including subscription_registration_coverage and
-- subscription_impact_event_registrations. Its header justified this by grepping the repo for a
-- literal `delete from ...subscription_registration_coverage` statement and finding none -- but it
-- missed an INDIRECT delete path that already existed in the ORIGINAL schema
-- (20260924100000_subscriptions_schema.sql): both tables declare
--   registration_id uuid references public.session_registrations (id) on delete cascade
--   manual_participant_id uuid references public.session_manual_participants (id) on delete cascade
-- and session_registrations.session_id itself references training_sessions (id) on delete cascade.
-- So: DELETE FROM training_sessions -> cascades to session_registrations/session_manual_participants
-- -> cascades to subscription_registration_coverage / subscription_impact_event_registrations -- and
-- the new guard trigger on those last two tables blocked that cascaded delete, aborting the whole
-- staff_delete_session_series_scope call (Postgres statement atomicity) for any session with a
-- subscription-covered participant.
--
-- Why these two tables are different from the other six (which KEEP the guard, unchanged by this
-- migration): subscriptions, subscription_versions, subscription_freezes,
-- subscription_billing_periods, subscription_charges and subscription_impact_events are standalone
-- money/history ledger rows with no FK that ever cascades them away -- they were correctly identified
-- as append-only. subscription_registration_coverage and subscription_impact_event_registrations hold
-- no money at all (no amount/charge column); they are coverage/audit METADATA about one specific
-- registration, and were always designed, from their very first migration, to cease to exist when
-- that registration does (the on delete cascade above is original schema, not new). Removing the
-- guard here does not weaken financial-integrity protection on any money-bearing table -- it restores
-- the exact pre-20261023130000 behavior for these two tables only.
--
-- Authorization is unchanged: both tables' RLS policy (subscription_registration_coverage_manager_all /
-- subscription_impact_event_registrations_manager_all, defined once in 20260924100000 and never
-- redefined since) has always been `for all using (is_manager(auth.uid()))` -- this migration does not
-- grant any new role or widen that policy; it only removes a trigger that sat on top of it, so the set
-- of people who can touch these rows at all is unchanged (managers only), and the real money-bearing
-- tables (subscriptions, subscription_versions, subscription_freezes, subscription_billing_periods,
-- subscription_charges, subscription_impact_events) keep their guard verbatim.

drop trigger if exists subscription_registration_coverage_hard_delete_guard on public.subscription_registration_coverage;
drop trigger if exists subscription_impact_event_registrations_hard_delete_guard on public.subscription_impact_event_registrations;

-- Self-check: the two fixed tables no longer carry the guard; the six money-bearing tables still do.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['subscription_registration_coverage', 'subscription_impact_event_registrations']
  loop
    if exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = v_table and t.tgname = v_table || '_hard_delete_guard' and not t.tgisinternal
    ) then
      raise exception 'self-check: % should no longer carry the hard-delete guard', v_table;
    end if;
  end loop;

  foreach v_table in array array[
    'subscriptions', 'subscription_versions', 'subscription_freezes',
    'subscription_billing_periods', 'subscription_charges', 'subscription_impact_events'
  ]
  loop
    if not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = v_table and t.tgname = v_table || '_hard_delete_guard' and not t.tgisinternal
    ) then
      raise exception 'self-check: % must keep its hard-delete guard', v_table;
    end if;
  end loop;
end $$;
