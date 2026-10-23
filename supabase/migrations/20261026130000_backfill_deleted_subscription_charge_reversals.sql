-- One-time, guarded, idempotent backfill: reverses the specific pre-existing subscription_charges
-- rows that 20261026100000's new delete_subscription would already have reversed at delete-time had
-- the payment guard + reversal logic existed when those subscriptions were deleted. This is the
-- production audit's ₪960 (four deleted subscriptions, zero payments against any of them -- see the
-- audit conversation; re-verified below by an exact-match guard before touching anything).
--
-- Safety properties:
--   - Exact-match guard: refuses to run (raises, no rows touched) unless production currently has
--     EXACTLY the four charges this migration was written against (same subscription ids, amounts,
--     charge types, and zero payments against any of them). Any drift since this was written --
--     another delete, a payment recorded, a reversal already applied -- aborts the whole migration.
--   - Idempotent: a second run is a no-op (the exact-match guard's own "not already reversed"
--     condition means there is nothing left to match a second time; see the COUNT check below).
--   - Append-only: inserts four `reversal` rows (same mechanism delete_subscription itself uses,
--     `reverses` linked back to the original charge). The original charge rows are never altered.
--   - Scoped by id, not by a wider predicate: each of the four charge ids below is named explicitly,
--     so this can never accidentally reverse a charge this migration wasn't written for.

do $$
declare
  v_expected_charge_ids uuid[] := array[
    '4b783318-9b84-4de4-9b30-4df5ca8973be'::uuid,  -- ₪100, subscription e5c07823-3724-430b-823e-7b38a76ff874
    '662fe014-bf1c-4eef-a8d7-8d304b6a1ddf'::uuid,  -- ₪100, subscription 2a079cfb-482b-4c13-ae9e-ef84a2b68873
    'bb970d84-84c2-43a6-8890-df13f02f6000'::uuid,  -- ₪400, subscription e805e442-99d2-47f9-a414-9d3a5bcc550d
    '159ca0d9-d68e-415a-b969-42f55081776d'::uuid   -- ₪360, subscription 4bd4d380-039f-4bb4-b23d-d559f9cc9d85
  ];
  v_expected_total numeric(12, 2) := 960.00;
  v_actual_total numeric(12, 2);
  v_actual_count int;
  v_already_reversed_count int;
  v_payment_count int;
  r record;
begin
  -- Exact-match guard, part 1: all four named charges must still exist, still unreversed, still
  -- recurring/proration, and sum to exactly ₪960.
  select count(*), coalesce(sum(c.amount_ils), 0)
    into v_actual_count, v_actual_total
  from public.subscription_charges c
  where c.id = any (v_expected_charge_ids)
    and c.charge_type in ('recurring', 'proration')
    and not exists (select 1 from public.subscription_charges rv where rv.charge_type = 'reversal' and rv.reverses = c.id);

  if v_actual_count <> array_length(v_expected_charge_ids, 1) or v_actual_total <> v_expected_total then
    raise exception 'backfill aborted: expected % unreversed charges totaling %, found % totaling % -- production state has drifted since this migration was written; do not force this through, re-investigate first',
      array_length(v_expected_charge_ids, 1), v_expected_total, v_actual_count, v_actual_total;
  end if;

  -- Exact-match guard, part 2: none of the four subscriptions may have ANY unreversed payment. If
  -- one does, the owner's policy requires stop_subscription, not a charge write-off -- abort instead
  -- of guessing.
  select count(*) into v_payment_count
  from public.athlete_account_payments a
  where a.reversed_at is null
    and a.source_subscription_id in (
      select distinct c.subscription_id from public.subscription_charges c where c.id = any (v_expected_charge_ids)
    );

  if v_payment_count > 0 then
    raise exception 'backfill aborted: % of the four subscriptions now has an unreversed payment -- re-investigate before writing anything off', v_payment_count;
  end if;

  -- Idempotency: if a previous (partial or full) run of this exact migration already reversed some
  -- of these, the count-based guard above would already have aborted (reversed charges are excluded
  -- from v_actual_count/v_actual_total) -- so reaching here means none of the four has been reversed
  -- yet. Re-confirm explicitly for clarity/auditability.
  select count(*) into v_already_reversed_count
  from public.subscription_charges rv
  where rv.charge_type = 'reversal' and rv.reverses = any (v_expected_charge_ids);
  if v_already_reversed_count > 0 then
    raise exception 'backfill aborted: % of the four charges already has a reversal row -- this migration may have partially run before; investigate rather than re-running blindly', v_already_reversed_count;
  end if;

  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.id = any (v_expected_charge_ids)
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id
    );
  end loop;

  raise notice 'backfill: reversed % charges totaling % -- production outstanding should now be 0 for these four subscriptions', v_actual_count, v_actual_total;
end $$;

-- Self-check: confirm all four are now excluded from the "effective" set, and that
-- manager_subscription_overview_stats's lifetime outstanding dropped by exactly ₪960 relative to what
-- it would have been (we don't know the absolute pre-migration value here, so this re-derives it: the
-- four named charges must now show zero net effect).
do $$
declare
  v_net numeric(12, 2);
begin
  select coalesce(sum(c.amount_ils), 0) into v_net
  from public.subscription_charges c
  where c.id in (
    '4b783318-9b84-4de4-9b30-4df5ca8973be', '662fe014-bf1c-4eef-a8d7-8d304b6a1ddf',
    'bb970d84-84c2-43a6-8890-df13f02f6000', '159ca0d9-d68e-415a-b969-42f55081776d'
  )
  or reverses in (
    '4b783318-9b84-4de4-9b30-4df5ca8973be', '662fe014-bf1c-4eef-a8d7-8d304b6a1ddf',
    'bb970d84-84c2-43a6-8890-df13f02f6000', '159ca0d9-d68e-415a-b969-42f55081776d'
  );
  if v_net <> 0 then
    raise exception 'self-check: the four original charges plus their new reversals should net to 0, got %', v_net;
  end if;
end $$;
