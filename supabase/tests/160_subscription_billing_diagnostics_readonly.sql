-- READ-ONLY production diagnostics for the subscription billing ledger (companion to 20261013100000 / 20261013110000).
--
-- Safe to run against production: SELECT only, no temp objects, no writes, no function calls with side effects
-- (subscription_billing_period_amount is a STABLE read). Returns aggregates (query 1) and, if anything is wrong, the
-- affected subscription / billing-period ids (query 2) -- ids only, no names, phones or amounts per person.
--
-- What each figure means:
--   dup_raw_overlap_pairs / dup_effective_overlap_pairs  > 0 -> duplicate billing periods for one cycle (the
--       freeze-then-edit defect fixed by 20261013110000); each duplicate carries its own original charge.
--   periods_active_charge_ne_1 > 0 -> a period with no live charge or more than one.
--   bad_reversals > 0 -> a reversal that does not mirror the charge it reverses.
--   periods_ledger_ne_engine > 0 -> the ledger net of a period differs from the engine's own amount: typically a
--       multi-period stop / edit that corrected only one period (fixed by 20261013110000). ledger_minus_engine_total_ils
--       is the total over-(+) or under-(-) charge.
--   periods_starting_beyond_today_plus_31 / corrections_without_matching_action > 0 -> billing rows that no manager
--       action or the daily job would have produced: possible direct calls to the internals (SEC-1, closed by 20261013100000).
-- Remediation of any non-zero figure is a reviewed, append-only correction (reversal + correct charge); never delete rows.

-- (1) aggregates
with bp as (select * from public.subscription_billing_periods),
ch as (select * from public.subscription_charges)
select jsonb_build_object(
  'today', public._studio_today_date(),
  'subscriptions_total', (select count(*) from public.subscriptions),
  'subscriptions_live', (select count(*) from public.subscriptions where deleted_at is null),
  'versions_stopped', (select count(*) from public.subscription_versions where stopped_effective_date is not null),
  'freezes_active', (select count(*) from public.subscription_freezes where cancelled_at is null),
  'impact_events_by_type', (select coalesce(jsonb_object_agg(action_type || ':' || confirmed, n), '{}'::jsonb)
                             from (select action_type::text, confirmed, count(*) n from public.subscription_impact_events group by 1, 2) z),
  'billing_periods', (select count(*) from bp),
  'charges_by_type', (select coalesce(jsonb_object_agg(charge_type, n), '{}'::jsonb) from (select charge_type::text, count(*) n from ch group by 1) z),
  'dup_raw_overlap_pairs', (select count(*) from bp a join bp b on a.subscription_id = b.subscription_id and a.id < b.id
                              and daterange(a.raw_period_start, a.raw_period_end) && daterange(b.raw_period_start, b.raw_period_end)),
  'dup_effective_overlap_pairs', (select count(*) from bp a join bp b on a.subscription_id = b.subscription_id and a.id < b.id
                              and daterange(a.period_start, a.period_end) && daterange(b.period_start, b.period_end)),
  'periods_active_charge_ne_1', (select count(*) from (select bp.id from bp left join ch c on c.billing_period_id = bp.id
                              and c.charge_type <> 'reversal' and not exists (select 1 from ch r where r.charge_type = 'reversal' and r.reverses = c.id)
                              group by bp.id having count(c.id) <> 1) z),
  'bad_reversals', (select count(*) from ch r left join ch o on o.id = r.reverses where r.charge_type = 'reversal'
                              and (o.id is null or o.billing_period_id <> r.billing_period_id or r.amount_ils <> -o.amount_ils)),
  'periods_ledger_ne_engine', (select count(*) from bp cross join lateral public.subscription_billing_period_amount(bp.subscription_id, bp.period_start, bp.period_end) e
                              where e.amount_ils <> (select coalesce(sum(c.amount_ils), 0) from ch c where c.billing_period_id = bp.id)),
  'ledger_minus_engine_total_ils', (select coalesce(sum((select coalesce(sum(c.amount_ils), 0) from ch c where c.billing_period_id = bp.id) - e.amount_ils), 0)
                              from bp cross join lateral public.subscription_billing_period_amount(bp.subscription_id, bp.period_start, bp.period_end) e),
  'periods_starting_beyond_today_plus_31', (select count(*) from bp where period_start > public._studio_today_date() + 31),
  'corrections_without_matching_action', (select count(*) from ch c where c.source_event_id is not null
                              and not exists (select 1 from public.subscription_impact_events ie where ie.action_source_id = c.source_event_id)
                              and not exists (select 1 from public.subscription_freezes f where f.id = c.source_event_id)),
  'billing_failed_events', (select count(*) from public.user_activity_events where event_type = 'subscription_billing_failed')
) as diagnostics;

-- (2) affected ids (empty when everything above is 0)
with bp as (select * from public.subscription_billing_periods),
ch as (select * from public.subscription_charges)
select 'duplicate_period' as finding, a.subscription_id, b.id as billing_period_id
  from bp a join bp b on a.subscription_id = b.subscription_id and a.id < b.id
   and daterange(a.raw_period_start, a.raw_period_end) && daterange(b.raw_period_start, b.raw_period_end)
union all
select 'ledger_ne_engine', bp.subscription_id, bp.id
  from bp cross join lateral public.subscription_billing_period_amount(bp.subscription_id, bp.period_start, bp.period_end) e
 where e.amount_ils <> (select coalesce(sum(c.amount_ils), 0) from ch c where c.billing_period_id = bp.id)
union all
select 'billed_far_ahead', bp.subscription_id, bp.id from bp where bp.period_start > public._studio_today_date() + 31
order by 1, 2, 3;
