#!/usr/bin/env bash
# Freeze honoured everywhere, and unfreeze for future, running and finished freezes. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"

echo "== A freeze extends the end date for coverage, status and billing"
mkuser athlete; A=$U; START=$(su -c "select (date_trunc('month', date '$TODAY') - interval '1 month')::date"); END=$(su -c "select (date '$START' + interval '3 months - 1 day')::date")
mksub "$A" "$START" 2 360 "$END"
F1=$(wk 1 0); F2=$(wk 1 6)   # 7 days
R=$(api "$M" "select public.freeze_subscription('$SUB','$F1','$F2',true)::text;"); expect "freeze applied" "applied" "$(jf "$R" action)"
EXT=$(su -c "select (date '$END' + 7)::date")
expect "effective end moved 7 days" "$EXT" "$(su -c "select public.subscription_effective_plan_end_date('$VER')")"
expect "in window on the extended last day" "t" "$(su -c "select (public.subscription_effective_context('$A',false,'$EXT','group')).in_window")"
expect "out of window the day after" "f" "$(su -c "select (public.subscription_effective_context('$A',false,(date '$EXT'+1),'group')).in_window")"
expect "not completed before the extended end" "active" "$(su -c "select public.subscription_version_display_status('$VER','$EXT')")"
expect "completed after it" "completed" "$(su -c "select public.subscription_version_display_status('$VER',(date '$EXT'+1))")"
RAW=$(su -c "select public.subscription_next_anchor_date(extract(day from date '$START')::smallint,(date '$END' + 1 - interval '1 month')::date)")
LAST_RAW=$(su -c "select (date_trunc('month', date '$END'))::date")
LAST_END=$(su -c "select public.subscription_next_anchor_date(extract(day from date '$START')::smallint,'$LAST_RAW')")
expect "the last cycle is charged in full" "360.00" "$(su -c "select amount_ils from public.subscription_billing_period_amount('$SUB',public.subscription_shifted_date('$SUB','$LAST_RAW'),public.subscription_shifted_date('$SUB','$LAST_END'))")"

echo "== Next charge: a future freeze inside the coming cycle extends its end, not its start"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; P=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
expect "next charge is the period end" "$P" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
FF=$(su -c "select (date '$P' + 5)::date"); FU=$(su -c "select (date '$P' + 14)::date")
api "$M" "select public.freeze_subscription('$SUB','$FF','$FU',true);" >/dev/null
expect "a later freeze does not move it" "$P" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
expect "next charge matches what the cron job would use" "$P" "$(su -c "select charge_date from public._subscription_next_charge('$SUB')")"

echo "== Next charge: a freeze inside the current cycle moves it, and periods stay contiguous"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; P=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
FF=$(d 3); FU=$(d 12)
api "$M" "select public.freeze_subscription('$SUB','$FF','$FU',true);" >/dev/null
EP=$(su -c "select (date '$P' + 10)::date")
expect "next charge moved 10 days" "$EP" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
expect "current period keeps its start, end moved" "$TODAY|$EP" "$(su -c "select period_start||'|'||period_end from public.subscription_billing_periods where subscription_id='$SUB'")"
expect "the charge did not change" "360.00" "$(charges "$SUB")"

echo "== Scheduled: next charge is the first charge"
mkuser athlete; A=$U; START=$(wk 2 2); mksub "$A" "$START" 2
expect "first charge on the start date" "$START" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
expect "scheduled status" "scheduled" "$(su -c "select public.subscription_version_display_status('$VER',public._studio_today_date())")"
G=$(api "$A" "select public.get_my_subscription()::text;")
expect "athlete sees it as scheduled" "true" "$(jf "$G" is_scheduled)"
expect "no this-week rows before it starts" "0" "$(su -c "select jsonb_array_length(('$G'::jsonb)->'weekly_usage')")"

echo "== A stopped subscription has no next charge"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$(d 3)',true,null);" >/dev/null
expect "no next charge" "" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"

echo "== Unfreeze a future freeze: preview changes nothing, confirm restores everything"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
mksession "$(wk 1 1)"; S1=$SX; mksession "$(wk 1 4)"; S2=$SX; mksession "$(wk 1 5)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
R=$(api "$M" "select public.freeze_subscription('$SUB','$(wk 1 0)','$(wk 1 3)',true)::text;")
FID=$(su -c "select id from public.subscription_freezes where subscription_id='$SUB'")
expect "frozen session not covered" "false:frozen" "$(cov "$R1")"
BEFORE=$(su -c "select public.subscription_effective_next_billing_date('$SUB')")
R=$(api "$M" "select public.unfreeze_subscription('$FID',false)::text;")
expect "preview" "preview" "$(jf "$R" action)"; expect "kind" "future_cancel" "$(jf "$R" kind)"
expect "preview lists the session change" "1" "$(su -c "select jsonb_array_length(('$R'::jsonb)->'session_changes')")"
expect "preview did not unfreeze" "" "$(su -c "select cancelled_at from public.subscription_freezes where id='$FID'")"
expect "preview did not change coverage" "false:frozen" "$(cov "$R1")"
R=$(api "$M" "select public.unfreeze_subscription('$FID',true)::text;")
expect "applied" "applied" "$(jf "$R" action)"
expect "session covered again" "true:" "$(cov "$R1")"
expect "who and when kept" "1" "$(su -c "select count(*) from public.subscription_freezes where id='$FID' and cancelled_at is not null and cancelled_by='$M'")"
expect "event recorded" "1" "$(su -c "select count(*) from public.subscription_impact_events where subscription_id='$SUB' and action_type='unfreeze'")"
expect "no extra charge" "360.00" "$(charges "$SUB")"
R=$(api "$M" "select public.unfreeze_subscription('$FID',true)::text;"); expect "retry" "already_applied" "$(jf "$R" action)"
R=$(api "$M" "select public.freeze_subscription('$SUB','$(wk 1 0)','$(wk 1 3)',true)::text;"); expect "same dates can be frozen again" "applied" "$(jf "$R" action)"
expect "frozen again" "false:frozen" "$(cov "$R1")"

echo "== Unfreeze a running freeze: ends today, history keeps the original end"
mkuser athlete; A=$U; START=$(d -20); mksub "$A" "$START" 2
R=$(api "$M" "select public.freeze_subscription('$SUB','$(d -5)','$(d 10)',true)::text;")
FID=$(su -c "select id from public.subscription_freezes where subscription_id='$SUB'")
R=$(api "$M" "select public.unfreeze_subscription('$FID',false)::text;"); expect "kind" "current_end_early" "$(jf "$R" kind)"
api "$M" "select public.unfreeze_subscription('$FID',true);" >/dev/null
expect "ends yesterday, original kept" "$(d -1)|$(d 10)" "$(su -c "select freeze_until||'|'||original_freeze_until from public.subscription_freezes where id='$FID'")"
expect "active today" "active" "$(su -c "select public.subscription_version_display_status('$VER',public._studio_today_date())")"
expect "frozen days are now 5" "$(su -c "select (public.subscription_next_anchor_date(extract(day from date '$START')::smallint,'$START') + 5)")" "$(su -c "select period_end from public.subscription_billing_periods where subscription_id='$SUB' order by raw_period_start limit 1")"

echo "== Reverse a finished freeze: sessions regain coverage, paid sessions keep their price, no duplicate charges"
mkuser athlete; A=$U; START=$(d -40); mksub "$A" "$START" 2
W0=$(lastsun 2); SD1=$(su -c "select (date '$W0' + 1)::date"); SD2=$(su -c "select (date '$W0' + 2)::date")
mksession "$SD1"; S1=$SX; past_reg "$A" "$S1" true; R1=$REG
mksession "$SD2"; S2=$SX; past_reg "$A" "$S2" true; R2=$REG
su -c "update public.session_registrations set amount_paid=50, payment_method='cash' where id='$R2'" >/dev/null
W=$(su -c "select date '$SD1' - extract(dow from date '$SD1')::int")
for pair in "$R1 $SD1" "$R2 $SD2"; do set -- $pair
  su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$1','$2','$W','group',true,'registration')" >/dev/null
done
su -c "select public.generate_due_subscription_charges()" >/dev/null
api "$M" "select public.freeze_subscription('$SUB','$W0','$(su -c "select (date '$W0' + 3)::date")',true);" >/dev/null
FID=$(su -c "select id from public.subscription_freezes where subscription_id='$SUB'")
expect "frozen: first not covered" "false:frozen" "$(cov "$R1")"
LEDGER=$(charges "$SUB")
R=$(api "$M" "select public.unfreeze_subscription('$FID',false)::text;"); expect "kind" "past_reversal" "$(jf "$R" kind)"
api "$M" "select public.unfreeze_subscription('$FID',true);" >/dev/null
expect "unpaid session covered again" "true:" "$(cov "$R1")"
expect "paid session keeps regular price" "false:paid_at_regular_price" "$(cov "$R2")"
expect "ledger total unchanged" "$LEDGER" "$(charges "$SUB")"
su -c "select public.generate_due_subscription_charges()" >/dev/null; su -c "select public.generate_due_subscription_charges()" >/dev/null
expect "one original charge per period" "0" "$(su -c "select count(*) from (select billing_period_id from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration') group by 1 having count(*)>1) x")"

echo "== Permissions"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
api "$M" "select public.freeze_subscription('$SUB','$(wk 2 0)','$(wk 2 1)',true);" >/dev/null
FID=$(su -c "select id from public.subscription_freezes where subscription_id='$SUB'")
contains "athlete refused" "forbidden" "$(api "$A" "select public.unfreeze_subscription('$FID',true)::text;")"
contains "coach refused" "forbidden" "$(api "$CO" "select public.unfreeze_subscription('$FID',true)::text;")"
contains "anon cannot execute" "permission denied" "$(api_as anon "" "select public.unfreeze_subscription('$FID',true)::text;")"
expect "still frozen" "" "$(su -c "select cancelled_at from public.subscription_freezes where id='$FID'")"

finish
