#!/usr/bin/env bash
# Duplicate and concurrent requests cannot duplicate charges or exceed an allowance. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
TMP=$(mktemp -d)

echo "== Two simultaneous bookings for the last slot: one covered, one over quota"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX
api "$A" "select public.register_for_session('$S1', true);" >/dev/null &
api "$A" "select public.register_for_session('$S2', true);" >/dev/null &
wait
expect "exactly one covered" "1" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB' and covered")"
expect "both booked" "2" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB'")"

echo "== Two simultaneous reactivations: one new subscription, one charge"
mkuser athlete; A=$U; mksub "$A" "$(d -40)" 2; SRC=$SUB
api "$M" "select public.stop_subscription_with_future_registrations('$SRC','$(d -30)',true,null);" >/dev/null
RS=$(d -1)
api "$M" "select public.reactivate_subscription('$SRC','$RS',null)::text;" > "$TMP/r1" &
api "$M" "select public.reactivate_subscription('$SRC','$RS',null)::text;" > "$TMP/r2" &
wait
expect "one new subscription" "2" "$(su -c "select count(*) from public.subscriptions where payee_id='$A' and deleted_at is null")"
expect "one refused" "1" "$(cat "$TMP/r1" "$TMP/r2" | grep -c conflicting_active_subscription)"
NEW=$(su -c "select id from public.subscriptions where payee_id='$A' and id<>'$SRC'")
expect "one charge" "1" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$NEW'")"

echo "== The billing job twice at once: one charge per period"
mkuser athlete; A=$U; mksub "$A" "$(su -c "select (date '$TODAY' - interval '3 months')::date")" 2
su -c "select public.generate_due_subscription_charges()" >/dev/null &
su -c "select public.generate_due_subscription_charges()" >/dev/null &
wait
expect "no period charged twice" "0" "$(su -c "select count(*) from (select billing_period_id from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration') group by 1 having count(*)>1) x")"
expect "cycles present" "t" "$(su -c "select count(*) >= 3 from public.subscription_charges where subscription_id='$SUB'")"

echo "== Two simultaneous stops and deletes"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; S=$SUB
api "$M" "select public.delete_subscription_with_future_registrations('$S');" >/dev/null &
api "$M" "select public.delete_subscription_with_future_registrations('$S');" >/dev/null &
wait
expect "reversed exactly once" "0.00" "$(charges "$S")"
expect "two ledger rows" "2" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$S'")"

echo "== Payment retries with one token record one payment"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; TOK=$(su -c "select gen_random_uuid()")
for i in 1 2 3; do api "$M" "select public.record_subscription_payment('$SUB',100,'cash',null,null,null,'$TOK');" >/dev/null & done
wait
expect "one payment" "1" "$(su -c "select count(*) from public.athlete_account_payments where source_subscription_id='$SUB'")"

echo "== Boundaries: Sunday reset, month ends, leap year, renewal day"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 6)"; S1=$SX; mksession "$(wk 2 0)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
expect "Saturday uses that week" "true:" "$(cov "$R1")"; expect "Sunday is a fresh week" "true:" "$(cov "$R2")"
mkuser athlete; A=$U; mksub "$A" "2028-01-31" 1
expect "anchor 31" "31" "$(su -c "select anchor_day from public.subscription_versions where subscription_id='$SUB'")"
expect "after leap Feb back to the 31st" "2028-03-31" "$(su -c "select public.subscription_next_anchor_date(31::smallint,'2028-02-29')")"
rm -rf "$TMP"
finish
