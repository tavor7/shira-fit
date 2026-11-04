#!/usr/bin/env bash
# Freeze billing rules on the real stack. Replaces the older stub-schema suites 71, 72, 92 and 124, which tested superseded
# function versions. Scenario names keep their old ids (B5, VC1, ...). SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
run_cron() { su -c "select public.generate_due_subscription_charges()" >/dev/null; }
periods() { su -c "select string_agg(period_start||'>'||period_end, ' ' order by raw_period_start) from public.subscription_billing_periods where subscription_id='$1'"; }
contiguous() { su -c "select count(*) from (select period_end, lead(period_start) over (order by raw_period_start) nxt from public.subscription_billing_periods where subscription_id='$1') x where nxt is not null and nxt <> period_end"; }
freeze() { api "$M" "select public.freeze_subscription('$1','$2','$3',true);" >/dev/null; }
sid() { su -c "select id from public.subscription_freezes where subscription_id='$1' order by freeze_from limit 1"; }
freeze_ok() { R=$(api "$M" "select public.freeze_subscription('$1','$2','$3',true)::text;"); expect "$4" "applied" "$(jf "$R" action)"; }

echo "== B5: a freeze inside a cycle extends its end by its length, at full price (a pause, not a discount)"
mkuser athlete; A=$U; S0=$(d -10); mksub "$A" "$S0" 2; RE=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
freeze "$SUB" "$(d 2)" "$(d 11)"
expect "period keeps its start, end +10" "$S0>$(su -c "select (date '$RE'+10)::date")" "$(periods "$SUB")"
expect "full price, no correction" "360.00|1" "$(su -c "select sum(amount_ils)||'|'||count(*) from public.subscription_charges where subscription_id='$SUB'")"

echo "== B6: a freeze covering a cycle's start delays its charge; nothing is charged early"
mkuser athlete; A=$U; mksub "$A" "$(d -20)" 2; RE=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
F1=$(su -c "select (date '$RE'-2)::date"); F2=$(su -c "select (date '$RE'+40)::date")
freeze "$SUB" "$F1" "$F2"; run_cron
expect "still one charge" "1" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB'")"
expect "next charge moved by the whole freeze" "$(su -c "select (date '$RE' + (date '$F2' - date '$F1' + 1))::date")" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"

echo "== B7: several cycles and several freezes, in the past: contiguous, every cycle once, at full price"
mkuser athlete; A=$U; S0=$(d -200); mksub "$A" "$S0" 2
freeze "$SUB" "$(d -150)" "$(d -141)"; freeze "$SUB" "$(d -90)" "$(d -71)"
run_cron; run_cron
N=$(su -c "select count(*) from public.subscription_billing_periods where subscription_id='$SUB'")
expect "no gaps or overlaps" "0" "$(contiguous "$SUB")"
expect "every cycle charged exactly once" "$N|$N" "$(su -c "select count(*)||'|'||count(distinct billing_period_id) from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration')")"
expect "all at full price" "0" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB' and amount_ils <> 360")"
expect "no covered days lost: active days equal the raw calendar" "0" "$(su -c "select count(*) from public.subscription_billing_periods bp where subscription_id='$SUB' and (period_end-period_start) - coalesce((select sum(least(f.freeze_until+1,bp.period_end)-greatest(f.freeze_from,bp.period_start)) from public.subscription_freezes f where f.subscription_id=bp.subscription_id and f.freeze_from<bp.period_end and f.freeze_until>=bp.period_start),0) <> (raw_period_end-raw_period_start)")"
expect "billing shifted by exactly the frozen days" "$(su -c "select public.subscription_next_anchor_date(extract(day from date '$S0')::smallint,(select max(raw_period_start) from public.subscription_billing_periods where subscription_id='$SUB')) + 30")" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
expect "the job posts nothing more" "$N" "$(run_cron; su -c "select count(*) from public.subscription_billing_periods where subscription_id='$SUB'")"

echo "== Unfreezing restores the schedule, without a double charge"
FID=$(sid "$SUB"); LEDGER=$(charges "$SUB"); COUNT=$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration')")
api "$M" "select public.unfreeze_subscription('$FID',true);" >/dev/null
expect "still contiguous" "0" "$(contiguous "$SUB")"
expect "ledger total unchanged" "$LEDGER" "$(charges "$SUB")"
run_cron
expect "catch-up posts at most what the shorter pause makes due" "t" "$(su -c "select count(*) >= $COUNT from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration')")"
expect "still no period charged twice" "0" "$(su -c "select count(*) from (select billing_period_id from public.subscription_charges where subscription_id='$SUB' and charge_type in ('recurring','proration') group by 1 having count(*)>1) x")"
expect "displayed next charge is what the job uses" "$(su -c "select charge_date from public._subscription_next_charge('$SUB')")" "$(su -c "select public.subscription_effective_next_billing_date('$SUB')")"
expect "and it is not already overdue" "t" "$(su -c "select public.subscription_effective_next_billing_date('$SUB') > date '$TODAY'")"

echo "== B9/B11: a freeze after the charge exists moves dates only; retries add nothing"
mkuser athlete; A=$U; mksub "$A" "$(d -10)" 2
R=$(api "$M" "select public.freeze_subscription('$SUB','$(d -5)','$(d -2)',true)::text;"); expect "applied" "applied" "$(jf "$R" action)"
R=$(api "$M" "select public.freeze_subscription('$SUB','$(d -5)','$(d -2)',true)::text;"); expect "retry" "already_applied" "$(jf "$R" action)"
expect "no reversal, ₪360 unchanged" "1|360.00" "$(su -c "select count(*)||'|'||sum(amount_ils) from public.subscription_charges where subscription_id='$SUB'")"

echo "== B8/B10: a stop prorates once, and retries add nothing"
mkuser athlete; A=$U; S0=$(d -10); mksub "$A" "$S0" 2; RE=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
ST=$(d -5); api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$ST',true,null);" >/dev/null
EXP=$(su -c "select round(360.0 * (date '$ST' - date '$S0') / (date '$RE' - date '$S0'), 2)")
expect "prorated to the days used" "$EXP" "$(charges "$SUB")"
expect "reversal + correction" "3" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB'")"
api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$ST',true,null);" >/dev/null; run_cron
expect "unchanged after retry and job" "3|$EXP" "$(su -c "select count(*)||'|'||sum(amount_ils) from public.subscription_charges where subscription_id='$SUB'")"

echo "== B12: repeated job runs are idempotent"
mkuser athlete; A=$U; mksub "$A" "$(d -100)" 2; run_cron; N=$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB'"); run_cron; run_cron
expect "no extra charges" "$N" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB'")"

echo "== VC1: a price change one day before the anchor prices that one day separately"
mkuser athlete; A=$U; S0=$(d -10); mksub "$A" "$S0" 2 300; RE=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
CUT=$(su -c "select (date '$RE'-1)::date"); api "$M" "select public.edit_subscription_version('$SUB','$CUT',600,null,false,null,true);" >/dev/null
EXP=$(su -c "select round((300.0 * (date '$CUT' - date '$S0') + 600) / (date '$RE' - date '$S0'), 2)")
expect "weighted by day" "$EXP" "$(charges "$SUB")"

echo "== VC2: a price change during a freeze: the frozen days contribute nothing"
mkuser athlete; A=$U; S0=$(d -10); mksub "$A" "$S0" 2 300; RE=$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$SUB'")
freeze "$SUB" "$(d -5)" "$(d -1)"
api "$M" "select public.edit_subscription_version('$SUB','$(d -3)',600,null,false,null,true);" >/dev/null
RAWD=$(su -c "select date '$RE' - date '$S0'")
EXP=$(su -c "select round((300.0 * (date '$(d -5)' - date '$S0') + 600.0 * ($RAWD - (date '$(d -5)' - date '$S0'))) / $RAWD, 2)")
expect "only active days are weighted" "$EXP" "$(charges "$SUB")"

echo "== A: a freeze is inclusive at both ends, resuming the day after"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; F1=$(wk 1 0); F2=$(wk 1 6); freeze "$SUB" "$F1" "$F2"
expect "frozen on the first day" "t" "$(su -c "select (public.subscription_effective_context('$A',false,'$F1','group')).is_frozen")"
expect "frozen on the last day" "t" "$(su -c "select (public.subscription_effective_context('$A',false,'$F2','group')).is_frozen")"
expect "active the day after" "f" "$(su -c "select (public.subscription_effective_context('$A',false,(date '$F2'+1),'group')).is_frozen")"

echo "== D/F: the end date extends across freezes, cumulatively, even one set after the freeze"
mkuser athlete; A=$U; END=$(d 200); mksub "$A" "$TODAY" 2 360 "$END"
freeze "$SUB" "$(d 10)" "$(d 16)"; expect "+7" "$(su -c "select (date '$END'+7)::date")" "$(su -c "select public.subscription_effective_plan_end_date('$VER')")"
freeze "$SUB" "$(d 30)" "$(d 39)"; expect "+17" "$(su -c "select (date '$END'+17)::date")" "$(su -c "select public.subscription_effective_plan_end_date('$VER')")"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; freeze "$SUB" "$(d 10)" "$(d 16)"
api "$M" "select public.edit_subscription_version('$SUB','$(d 1)',null,'$END',false,null,true);" >/dev/null
VER2=$(su -c "select id from public.subscription_versions where subscription_id='$SUB' and effective_to is null")
expect "counted once an end exists" "$(su -c "select (date '$END'+7)::date")" "$(su -c "select public.subscription_effective_plan_end_date('$VER2')")"

echo "== G/H/I/J: allowance proration under freezes"
limit_case() { # limit, freeze from day, to day, expected
  mkuser athlete; A=$U; mksub "$A" "$TODAY" "$1"; freeze "$SUB" "$(wk 1 "$2")" "$(wk 1 "$3")"
  expect "$1/week frozen day $2-$3 -> $4" "$4" "$(su -c "select public.subscription_effective_weekly_limit('$A',false,'group','$(wk 1 0)')")"
}
limit_case 3 0 3 1; limit_case 4 0 3 2; limit_case 3 1 1 3; limit_case 3 0 5 0

echo "== K: a Saturday session is outside the denominator but consumes the allowance"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1; freeze "$SUB" "$(wk 1 0)" "$(wk 1 3)"
mksession "$(wk 1 6)"; S1=$SX; mksession "$(wk 1 4)"; S2=$SX; register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
expect "Saturday covered" "true:" "$(cov "$R1")"; expect "the next is over quota" "false:allowance_exceeded" "$(cov "$R2")"

echo "== L: a lower limit after a freeze goes to the earliest booking"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
mksession "$(wk 1 4)"; S1=$SX; mksession "$(wk 1 5)"; S2=$SX; register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
expect "both covered first" "true:|true:" "$(cov "$R1")|$(cov "$R2")"
freeze "$SUB" "$(wk 1 0)" "$(wk 1 3)"
expect "earliest keeps it" "true:" "$(cov "$R1")"; expect "the later goes over quota" "false:allowance_exceeded" "$(cov "$R2")"
finish
