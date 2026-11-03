#!/usr/bin/env bash
# Reports, family totals and the Overview agree, and the utilization metric reconciles. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
stats_mode() { api "$M" "select public.manager_weekly_stats_core('$1','$2')::text;"; }

echo "== Reports: daily expected equals the athlete total, with covered sessions at zero and charges on their own line"
FW=$(wk 8 0)
mkuser athlete; A=$U
su -c "insert into public.athlete_session_capacity_pricing (user_id, capacity, price_ils, effective_from) values ('$A', 8, 50, '2020-01-01') on conflict do nothing" >/dev/null 2>&1
J00=$(stats_mode "$FW" week); BASE0=$(su -c "select coalesce(('$J00'::jsonb)#>>'{finance,athlete_totals,expected_ils}','0')"); CH0=$(su -c "select coalesce(sum((d->>'subscription_charges_ils')::numeric),0) from jsonb_array_elements(('$J00'::jsonb)#>'{finance,expected_by_day}') d")
mksub "$A" "$FW" 1
mksession "$(wk 8 0)"; S1=$SX; mksession "$(wk 8 1)"; S2=$SX
su -c "update public.training_sessions set custom_slot_price_ils=50 where id in ('$S1','$S2')" >/dev/null
past_reg "$A" "$S1"; R1=$REG; past_reg "$A" "$S2"; R2=$REG
su -c "select public.subscription_reconcile_week('$SUB','$FW','group')" >/dev/null
mark "$R1" true; mark "$R2" true
su -c "select public.subscription_generate_or_correct_billing_period('$SUB','$VER','$FW',public.subscription_next_anchor_date(extract(day from date '$FW')::smallint,'$FW'),null,null)" >/dev/null
J=$(stats_mode "$FW" week)
TOT=$(su -c "select ('$J'::jsonb)#>>'{finance,athlete_totals,expected_ils}'")
DAY=$(su -c "select sum((d->>'expected_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,expected_by_day}') d")
expect "over-quota session + charge" "410.00" "$(su -c "select $TOT - $BASE0")"
expect "daily totals agree" "$TOT" "$DAY"
expect "charge shown on its own line" "360.00" "$(su -c "select sum((d->>'subscription_charges_ils')::numeric) - $CH0 from jsonb_array_elements(('$J'::jsonb)#>'{finance,expected_by_day}') d")"

echo "== Reports: a reversed payment leaves daily collections"
PD=$(wk 9 2)
PAY=$(su -c "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at) values ('$A',false,70,'cash','$PD') returning id" | head -1)
J=$(stats_mode "$PD" week)
expect "counted while live" "70.00" "$(su -c "select sum((d->>'account_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,collections_by_day}') d")"
api "$M" "select public.manager_reverse_account_payment('$PAY','test');" >/dev/null
J=$(stats_mode "$PD" week)
expect "gone once reversed" "" "$(su -c "select sum((d->>'account_ils')::numeric) from jsonb_array_elements(('$J'::jsonb)#>'{finance,collections_by_day}') d")"
expect "athlete totals agree" "0.00" "$(su -c "select ('$J'::jsonb)#>>'{finance,athlete_totals,collected_account_ils}'")"

echo "== Family totals: a discount is not cash; outstanding unchanged"
mkuser athlete; B=$U; DW=$(wk 10 0)
mksession "$DW"; S=$SX; su -c "update public.training_sessions set custom_slot_price_ils=100 where id='$S'" >/dev/null; past_reg "$B" "$S" true
su -c "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at) values ('$B',false,30,'discount','$DW'),('$B',false,20,'cash','$DW')" >/dev/null
RW=$(su -c "select expected_ils||'|'||collected_account_ils||'|'||collected_total_ils||'|'||outstanding_ils from public._period_merged_athlete_finance('$DW','$DW') where pid='$B'")
expect "expected reduced, cash only, outstanding right" "70.00|20.00|20.00|50.00" "$RW"
J=$(stats_mode "$DW" week)
expect "athlete row agrees" "70.00|20.00|50.00" "$(su -c "select a->>'expected_ils' || '|' || (a->>'collected_account_ils') || '|' || (a->>'outstanding_ils') from jsonb_array_elements(('$J'::jsonb)#>'{finance,athletes}') a where a->>'id'='$B'")"

echo "== Family totals are the sum of their members, and match the athlete rows"
mkuser athlete; B2=$U
mksession "$DW"; S2=$SX; su -c "update public.training_sessions set custom_slot_price_ils=40 where id='$S2'" >/dev/null; past_reg "$B2" "$S2" true
FAM=$(su -c "insert into public.athlete_families(name) values ('h-family') returning id" | head -1)
su -c "insert into public.athlete_family_members(family_id,user_id) values ('$FAM','$B'),('$FAM','$B2')" >/dev/null
expect "family expected, cash and balance" "110.00|20.00|90.00" "$(su -c "select f->>'expected_ils' || '|' || (f->>'collected_total_ils') || '|' || (f->>'outstanding_ils') from json_array_elements(public._manager_weekly_stats_families_json('$DW','$DW')) f where f->>'id'='$FAM'")"

echo "== Overview status counts, open balance and credit"
mkuser athlete; C=$U; mksub "$C" "$TODAY" 2; api "$M" "select public.record_subscription_payment('$SUB',500,'cash',null,null,null,null);" >/dev/null
J=$(api "$M" "select public.manager_subscription_overview_stats('$TODAY','$TODAY')::text;")
expect "credit is shown apart" "t" "$(su -c "select (('$J'::jsonb)->>'credit_ils')::numeric >= 140")"
expect "outstanding = open - credit" "t" "$(su -c "select (('$J'::jsonb)->>'outstanding_ils')::numeric = (('$J'::jsonb)->>'open_balance_ils')::numeric - (('$J'::jsonb)->>'credit_ils')::numeric")"

echo "== Utilization: past, current and future, reconciled with per-person usage"
W=$(wk 12 0); util() { api "$M" "select public.manager_subscription_week_utilization('$1')::text;"; }
BASE=$(util "$W")
BA=$(jf "$BASE" available); BU=$(jf "$BASE" reserved)
mkuser athlete; E=$U; mksub "$E" "$TODAY" 3; ES=$SUB
mksession "$(wk 12 0)"; A1=$SX; mksession "$(wk 12 1)"; A2=$SX; mksession "$(wk 12 2)"; A3=$SX; mksession "$(wk 12 3)"; A4=$SX
register "$E" "$A1"; R1=$REG; register "$E" "$A2"; R2=$REG; register "$E" "$A3"; R3=$REG; register "$E" "$A4"; R4=$REG
J=$(util "$W")
expect "future week reads future" "future" "$(jf "$J" mode)"
expect "available grew by the limit" "$((BA+3))" "$(jf "$J" available)"
expect "reserved grew by the covered" "$((BU+3))" "$(jf "$J" reserved)"
expect "over-quota counted apart" "1" "$(su -c "select r->>'extra' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$E'")"
mark "$R1" true; mark "$R2" false false
J=$(util "$W")
expect "attended counts as used" "1" "$(su -c "select r->>'attended' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$E'")"
expect "the no-show is not used" "1" "$(su -c "select r->>'released' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$E'")"
expect "its slot went to the over-quota booking" "0" "$(su -c "select r->>'extra' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$E'")"
RECON=$(su -c "select count(*) from jsonb_array_elements(('$J'::jsonb)->'rows') r where (r->>'occupied')::int <> (r->>'attended')::int+(r->>'penalty')::int+(r->>'unmarked')::int+(r->>'reserved')::int")
expect "row states add up" "0" "$RECON"
expect "totals identity" "t" "$(su -c "select (j->>'used')::int+(j->>'unmarked')::int+(j->>'reserved')::int+(j->>'remaining')::int = (j->>'available')::int+(j->>'over_allocated')::int from (select '$J'::jsonb j) x")"
expect "same as the per-person engine" "$(su -c "select e->>'used' from jsonb_array_elements(public._subscription_week_usage('$ES','$E',false,'$W',array['group']::public.subscription_tier[])) e")" "$(su -c "select r->>'occupied' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$E'")"

echo "== Utilization: a plan change inside a week is one allowance, not two"
mkuser athlete; F=$U; mksub "$F" "$TODAY" 2; OLD=$SUB
api "$M" "select public.stop_subscription_with_future_registrations('$OLD','$(wk 13 3)',true,null);" >/dev/null
mksub "$F" "$(wk 13 3)" 2
J=$(util "$(wk 13 0)")
expect "one row, limit 2" "1|2" "$(su -c "select count(*)||'|'||sum((r->>'available')::int) from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$F'")"

echo "== Utilization: deleted subscriptions and partial weeks"
mkuser athlete; H=$U; mksub "$H" "$(wk 14 4)" 2   # Thu start: 1
J=$(util "$(wk 14 0)")
expect "partial week prorated" "1" "$(su -c "select r->>'available' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$H'")"
api "$M" "select public.delete_subscription_with_future_registrations('$SUB');" >/dev/null
J=$(util "$(wk 14 0)")
expect "deleted subscription gone" "" "$(su -c "select r->>'available' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$H'")"

echo "== Utilization: over-allocation is surfaced, not hidden"
OV0=$(jf "$(util "$(wk 15 0)")" over_allocated)
mkuser athlete; K=$U; mksub "$K" "$TODAY" 1
mksession "$(wk 15 0)"; O1=$SX; mksession "$(wk 15 1)"; O2=$SX
register "$K" "$O1"; RO1=$REG; register "$K" "$O2"; RO2=$REG
su -c "update public.subscription_registration_coverage set covered=true, non_coverage_reason=null where registration_id='$RO2'" >/dev/null
J=$(util "$(wk 15 0)")
expect "shown" "$((OV0+1))" "$(jf "$J" over_allocated)"
expect "remaining not negative" "0" "$(su -c "select r->>'remaining' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$K'")"
contains "non-manager refused" "forbidden" "$(api "$CO" "select public.manager_subscription_week_utilization('$TODAY')::text;")"
finish
