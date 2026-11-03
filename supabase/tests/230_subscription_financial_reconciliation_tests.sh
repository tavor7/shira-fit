#!/usr/bin/env bash
# One athlete with every kind of financial event, hand-calculated, read through every surface. SCRATCH DATABASES ONLY.
#
#   subscription charge ₪300 | covered session (0) | over-quota attended ₪50, ₪20 paid at the session | over-quota charged no-show ₪50
#   subscription payment ₪100 | general payment ₪40 | discount ₪10 | general payment ₪70, reversed
#   expected 400 - 10 = 390 | sessions cash 20 | account cash 140 | collected 160 | outstanding 230
. "$(dirname "$0")/lib_subscription_harness.sh"
# A future Sunday early in a month, so the week and the month hold exactly the same events.
W=$(su -c "select d::date from generate_series(date '$TODAY' + 200, date '$TODAY' + 300, interval '1 day') d where extract(dow from d)=0 and extract(day from d) between 1 and 15 limit 1")
day() { su -c "select (date '$W' + $1)::date"; }
base() { J=$(api "$M" "select public.manager_weekly_stats_core('$W','$1')::text;"); }

mkuser athlete; A=$U; mkuser athlete; B=$U
mksub "$A" "$W" 1 300
su -c "select public.subscription_generate_or_correct_billing_period('$SUB','$VER','$W',public.subscription_next_anchor_date(extract(day from date '$W')::smallint,'$W'),null,null)" >/dev/null
for off in 0 1 2; do mksession "$(day "$off")"; eval "S$off=$SX"; done
su -c "update public.training_sessions set custom_slot_price_ils=50 where id in ('$S0','$S1','$S2')" >/dev/null
register "$A" "$S0"; R0=$REG; register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
su -c "update public.session_registrations set attended=true where id='$R0'; update public.session_registrations set attended=true, amount_paid=20, payment_method='cash' where id='$R1'; update public.session_registrations set attended=false, charge_no_show=true where id='$R2'" >/dev/null
api "$M" "select public.record_subscription_payment('$SUB',100,'cash',null,null,'$(day 1)',null);" >/dev/null
su -c "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at) values ('$A',false,40,'cash','$(day 2)'),('$A',false,10,'discount','$(day 2)')" >/dev/null
P=$(su -c "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at) values ('$A',false,70,'cash','$(day 3)') returning id" | head -1)
api "$M" "select public.manager_reverse_account_payment('$P','typed twice');" >/dev/null
mksession "$(day 3)"; SB=$SX; su -c "update public.training_sessions set custom_slot_price_ils=30 where id='$SB'" >/dev/null; past_reg "$B" "$SB" true
FAM=$(su -c "insert into public.athlete_families(name) values ('recon') returning id" | head -1)
su -c "insert into public.athlete_family_members(family_id,user_id) values ('$FAM','$A'),('$FAM','$B')" >/dev/null

for mode in week month; do
  echo "== Reports, $mode view"
  base $mode
  ROW=$(su -c "select a->>'expected_ils'||'|'||(a->>'collected_sessions_ils')||'|'||(a->>'collected_account_ils')||'|'||(a->>'collected_total_ils')||'|'||(a->>'outstanding_ils') from jsonb_array_elements(('$J'::jsonb)#>'{finance,athletes}') a where a->>'id'='$A'")
  expect "athlete row" "390.00|20.00|140.00|160.00|230.00" "$ROW"
  expect "daily expected = before discount, all events" "430.00" "$(su -c "select sum((d->>'expected_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,expected_by_day}') d")"
  expect "charge on its own line" "300.00" "$(su -c "select sum((d->>'subscription_charges_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,expected_by_day}') d")"
  expect "daily collected = real cash, no reversal, no discount" "160.00" "$(su -c "select sum((d->>'collected_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,collections_by_day}') d")"
  expect "cash by method" "160.00" "$(su -c "select ('$J'::jsonb)#>>'{finance,amounts_by_method,cash}'")"
  expect "discount is not a method of cash" "" "$(su -c "select ('$J'::jsonb)#>>'{finance,amounts_by_method,discount}'")"
done

echo "== Family totals are their members'"
expect "family row" "420.00|160.00|260.00" "$(su -c "select f->>'expected_ils'||'|'||(f->>'collected_total_ils')||'|'||(f->>'outstanding_ils') from json_array_elements(public._manager_weekly_stats_families_json('$W','$(day 6)')) f where f->>'id'='$FAM'")"

echo "== The account balance the reminders use"
expect "same outstanding" "230.00" "$(su -c "select balance from public._payment_balance_rows() where pid='$A'")"

echo "== Subscription surfaces"
expect "breakdown: charges, linked payments, open" "300.00|100.00|200.00" "$(api "$M" "select charges_total_ils||'|'||payments_total_ils||'|'||outstanding_ils from public.manager_subscription_overview_breakdown() where subscription_id='$SUB';")"
expect "subscription's own outstanding" "200.00" "$(su -c "select public._subscription_outstanding('$SUB')")"
S=$(api "$M" "select public.manager_subscription_overview_stats('$W','$(day 6)')::text;")
expect "Overview: charged in the period includes this ₪300" "t" "$(su -c "select (('$S'::jsonb)->>'charges_total_ils')::numeric >= 300")"
expect "Overview: outstanding = open - credit" "t" "$(su -c "select (('$S'::jsonb)->>'outstanding_ils')::numeric = (('$S'::jsonb)->>'open_balance_ils')::numeric - (('$S'::jsonb)->>'credit_ils')::numeric")"

echo "== Week usage, Overview row and the detail RPC agree"
U=$(api "$M" "select public.manager_subscription_week_utilization('$W')::text;")
expect "Overview row: limit, occupied, extra" "1|1|2" "$(su -c "select r->>'available'||'|'||(r->>'occupied')||'|'||(r->>'extra') from jsonb_array_elements(('$U'::jsonb)->'rows') r where r->>'payee_id'='$A'")"
D=$(api "$M" "select public.get_subscription_weekly_usage('$SUB','$W')::text;")
expect "detail screen" "1|1|2" "$(su -c "select e->>'effective_weekly_limit'||'|'||(e->>'used')||'|'||(e->>'extra') from jsonb_array_elements(('$D'::jsonb)->'usage') e where e->>'tier'='group'")"

echo "== No regression into duplicates"
expect "one original charge per period" "0" "$(su -c "select count(*) from (select billing_period_id from public.subscription_charges where charge_type in ('recurring','proration') group by 1 having count(*)>1) x")"
expect "every reversal mirrors its charge" "0" "$(su -c "select count(*) from public.subscription_charges r join public.subscription_charges o on o.id=r.reverses where r.amount_ils <> -o.amount_ils")"
expect "no charge reversed twice" "0" "$(su -c "select count(*) from (select reverses from public.subscription_charges where reverses is not null group by 1 having count(*)>1) x")"
finish
