#!/usr/bin/env bash
# Regression suite for the subscription lifecycle and coverage remediation. Every scenario drives real RPCs and real
# triggers. SCRATCH/LOCAL DATABASES ONLY (commits fixtures).
. "$(dirname "$0")/lib_subscription_harness.sh"

echo "== P0-A: stop with 'remove' really removes the future registration"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
mksession "$(wk 2 0)"; S=$SX; register "$A" "$S"; REGX=$REG
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$(wk 1 3)',true,'remove',ARRAY['$REGX']::uuid[],ARRAY[]::uuid[])::text;")
expect "action applied" "applied" "$(jf "$R" action)"
expect "one registration resolved" "1" "$(jf "$R" future_registrations_resolved)"
expect "registration cancelled" "cancelled" "$(su -c "select status from public.session_registrations where id='$REGX'")"
expect "coverage row gone" "none" "$(cov "$REGX")"

echo "== P0-A: stop with 'charge_regular_price' keeps the booking at regular price, reason subscription_ended"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
mksession "$(wk 2 0)"; S=$SX; register "$A" "$S"; REGX=$REG
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$(wk 1 3)',true,'charge_regular_price',ARRAY['$REGX']::uuid[],ARRAY[]::uuid[])::text;")
expect "one registration resolved" "1" "$(jf "$R" future_registrations_resolved)"
expect "registration stays active" "active" "$(su -c "select status from public.session_registrations where id='$REGX'")"
expect "regular price, reason kept" "false:subscription_ended" "$(cov "$REGX")"
mark "$REGX" true
expect "attendance edit does not change the outcome" "false:subscription_ended" "$(cov "$REGX")"

echo "== P0-A: repeated stop with the same request is idempotent; a different date applies"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
D1=$(wk 1 3); D2=$(wk 1 5)
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$D1',true,null)::text;"); expect "first stop applied" "applied" "$(jf "$R" action)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$D1',true,null)::text;"); expect "retry is already_applied" "already_applied" "$(jf "$R" action)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$D2',true,null)::text;"); expect "new date applied" "applied" "$(jf "$R" action)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$D1',true,null)::text;"); expect "back to first date applies" "applied" "$(jf "$R" action)"
expect "stop date is the last one requested" "$D1" "$(su -c "select stopped_effective_date from public.subscription_versions where subscription_id='$SUB' and effective_to is null")"

echo "== P0-B: partial first week: over-quota stays over quota when attendance is marked"
mkuser athlete; A=$U; START=$(wk 0 4); mksub "$A" "$START" 2     # Thu+Fri => ceil(2*2/6) = 1
mksession "$(wk 0 4)"; S1=$SX; mksession "$(wk 0 5)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
expect "first covered" "true:" "$(cov "$R1")"; expect "second over quota" "false:allowance_exceeded" "$(cov "$R2")"
mark "$R1" true
expect "second STILL over quota after attendance" "false:allowance_exceeded" "$(cov "$R2")"
expect "usage used=1 limit=1 extra=1" "1|1|1" "$(su -c "select e->>'used' || '|' || (e->>'effective_weekly_limit') || '|' || (e->>'extra') from jsonb_array_elements(public._subscription_week_usage('$SUB','$A',false,'$(wk 0 0)',array['group']::public.subscription_tier[])) e")"

echo "== P0-B: partial last week"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2 360 "$(wk 0 1)"       # ends Mon => Sun+Mon => ceil(2*2/6) = 1
mksession "$(wk 0 0)"; S1=$SX; mksession "$(wk 0 1)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; mark "$R1" true
expect "first covered" "true:" "$(cov "$R1")"; expect "second over quota" "false:allowance_exceeded" "$(cov "$R2")"

echo "== P0-B: partly frozen week"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
R=$(api "$M" "select public.freeze_subscription('$SUB','$(wk 1 0)','$(wk 1 3)',true)::text;")
mksession "$(wk 1 4)"; S1=$SX; mksession "$(wk 1 5)"; S2=$SX; mksession "$(wk 1 1)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; register "$A" "$S3"; R3=$REG; mark "$R1" true
expect "first covered" "true:" "$(cov "$R1")"; expect "second over quota" "false:allowance_exceeded" "$(cov "$R2")"; expect "frozen date" "false:frozen" "$(cov "$R3")"

echo "== P0-C / Decision 1: reactivation sets a new anchor and one charge"
mkuser athlete; A=$U; PAST=$(su -c "select (date '$TODAY' - 60)::date")
mksub "$A" "$PAST" 2; SRC=$SUB
api "$M" "select public.stop_subscription_with_future_registrations('$SRC','$(su -c "select (date '$PAST' + 10)::date")',true,null);" >/dev/null
RS=$(d -1)
R=$(api "$M" "select public.reactivate_subscription('$SRC','$RS',null)::text;"); NEW=$(jf "$R" subscription_id)
expect "anchor is the reactivation day" "$(su -c "select extract(day from date '$RS')::int")" "$(su -c "select anchor_day from public.subscription_versions where subscription_id='$NEW'")"
expect "one charge at full price" "1|360.00" "$(su -c "select count(*)||'|'||sum(amount_ils) from public.subscription_charges where subscription_id='$NEW'")"
expect "period is one full month" "$(su -c "select public.subscription_next_anchor_date(extract(day from date '$RS')::smallint,'$RS')")" "$(su -c "select raw_period_end from public.subscription_billing_periods where subscription_id='$NEW'")"
su -c "select public.generate_due_subscription_charges()" >/dev/null
expect "cron does not add a second charge" "1" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$NEW'")"
R=$(api "$M" "select public.reactivate_subscription('$SRC','$RS',null)::text;")
expect "repeat is refused" "conflicting_active_subscription" "$(jf "$R" error)"
expect "history of the source is intact" "1" "$(su -c "select count(*) from public.subscription_versions where subscription_id='$SRC'")"

echo "== Anchor clamping for ordinary subscriptions, and reactivation on the 31st"
expect "31 Jan -> 28 Feb" "2027-02-28" "$(su -c "select public.subscription_next_anchor_date(31::smallint,'2027-01-31')")"
expect "28 Feb -> 31 Mar" "2027-03-31" "$(su -c "select public.subscription_next_anchor_date(31::smallint,'2027-02-28')")"
expect "leap year 31 Jan -> 29 Feb" "2028-02-29" "$(su -c "select public.subscription_next_anchor_date(31::smallint,'2028-01-31')")"

echo "== Decision 2: future bookings made before the subscription are evaluated at creation"
mkuser athlete; A=$U
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; mksession "$(wk 1 2)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; register "$A" "$S3"; R3=$REG
mksession "$(lastsun 1)"; SP=$SX; past_reg "$A" "$SP" true; RP=$REG
mksub "$A" "$(lastsun 2)" 2
expect "first future covered" "true:" "$(cov "$R1")"; expect "second future covered" "true:" "$(cov "$R2")"
expect "third is regular price" "false:allowance_exceeded" "$(cov "$R3")"
expect "past session untouched" "none" "$(cov "$RP")"
expect "no-op for history: Reports still price it" "t" "$(su -c "select not exists (select 1 from public.subscription_registration_coverage where registration_id='$RP')")"

echo "== Decision 3: an unpenalized no-show releases the allowance"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; mksession "$(wk 1 2)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; register "$A" "$S3"; R3=$REG
expect "third over quota" "false:allowance_exceeded" "$(cov "$R3")"
mark "$R1" false false
expect "no-show released" "false:no_show_released" "$(cov "$R1")"
expect "the slot goes to the over-quota booking" "true:" "$(cov "$R3")"
mark "$R1" false true
expect "a charged no-show takes its slot back, first booked first covered" "true:" "$(cov "$R1")"
expect "and the promoted booking returns to over quota" "false:allowance_exceeded" "$(cov "$R3")"
mark "$R1" null false
mark "$R3" false false
expect "releasing the promoted booking restores the first" "true:" "$(cov "$R1")"

echo "== Decision 3: booking eligibility sees the released slot"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX
register "$A" "$S1"; R1=$REG; mark "$R1" false false
register "$A" "$S2"; R2=$REG
expect "new booking is covered" "true:" "$(cov "$R2")"

echo "== Decision 3: a charged late cancellation still consumes the allowance"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
su -c "update public.session_registrations set status='cancelled' where id='$R1'; insert into public.cancellations (session_id, user_id, charged_full_price, reason) values ('$S1','$A',true,'test')" >/dev/null
expect "penalty keeps the slot" "true:" "$(cov "$R1")"
expect "second stays over quota" "false:allowance_exceeded" "$(cov "$R2")"

echo "== Paid regular-price sessions are never silently repriced by a freed slot"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
su -c "update public.session_registrations set amount_paid=50, payment_method='cash' where id='$R2'" >/dev/null
mark "$R1" false false
expect "paid booking keeps regular price" "false:paid_at_regular_price" "$(cov "$R2")"

echo "== Manual participant removal frees the slot immediately"
mkmanual; R=$(api "$M" "select public.create_subscription('$MP', true, 360, '$TODAY', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',1)))::text;"); SUB=$(jf "$R" subscription_id)
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX
SM1=$(su -c "insert into public.session_manual_participants(session_id, manual_participant_id, added_at) values ('$S1','$MP',now()-interval '2 min') returning id" | head -1)
SM2=$(su -c "insert into public.session_manual_participants(session_id, manual_participant_id, added_at) values ('$S2','$MP',now()-interval '1 min') returning id" | head -1)
su -c "select public.subscription_reconcile_week('$SUB','$(wk 1 0)','group')" >/dev/null
expect "second manual over quota" "false:allowance_exceeded" "$(covm "$SM2")"
api "$M" "select public.remove_manual_participant_from_session('$S1','$MP');" >/dev/null
expect "second manual now covered" "true:" "$(covm "$SM2")"

echo "== Same-day edits A -> B -> A -> B all apply"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; E=$(d 5)
for P in 400 360 400; do
  R=$(api "$M" "select public.edit_subscription_version('$SUB','$E',$P,null,false,null,true)::text;")
  expect "price $P applied" "applied" "$(jf "$R" action)"
  expect "current price $P" "$P.00" "$(su -c "select monthly_price_ils from public.subscription_versions where subscription_id='$SUB' and effective_to is null")"
done
R=$(api "$M" "select public.edit_subscription_version('$SUB','$E',400,null,false,null,true)::text;")
expect "true retry is already_applied" "already_applied" "$(jf "$R" action)"

echo "== Stop and restart in one week: no allowance stacking"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 2; OLD=$SUB
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; mksession "$(wk 1 3)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
api "$M" "select public.stop_subscription_with_future_registrations('$OLD','$(wk 1 3)',true,null);" >/dev/null
mksub "$A" "$(wk 1 3)" 2
register "$A" "$S3"; R3=$REG
expect "limit is 2 for the week" "2" "$(su -c "select public.subscription_effective_weekly_limit('$A',false,'group','$(wk 1 0)')")"
expect "third is over quota" "false:allowance_exceeded" "$(cov "$R3")"

echo "== A plan edit inside a week: one allowance for the week, the later version's limit"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 3
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 1 1)"; S2=$SX; mksession "$(wk 1 4)"; S3=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG; register "$A" "$S3"; R3=$REG
R=$(api "$M" "select public.edit_subscription_version('$SUB','$(wk 1 3)',null,null,false,jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)),true)::text;")
expect "two versions in that week give limit 2" "2" "$(su -c "select public.subscription_effective_weekly_limit('$A',false,'group','$(wk 1 0)')")"
expect "two covered" "2" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB' and week_start='$(wk 1 0)' and covered")"
expect "third over quota" "false:allowance_exceeded" "$(cov "$R3")"
expect "usage counts one person once" "2|2|1" "$(su -c "select e->>'used' || '|' || (e->>'effective_weekly_limit') || '|' || (e->>'extra') from jsonb_array_elements(public._subscription_week_usage('$SUB','$A',false,'$(wk 1 0)',array['group']::public.subscription_tier[])) e")"

echo "== Moving a session keeps coverage in the right week and tier"
mkuser athlete; A=$U; mksub "$A" "$TODAY" 1
mksession "$(wk 1 0)"; S1=$SX; mksession "$(wk 2 0)"; S2=$SX
register "$A" "$S1"; R1=$REG; register "$A" "$S2"; R2=$REG
su -c "update public.training_sessions set session_date='$(wk 2 1)' where id='$S1'" >/dev/null
expect "row follows the session" "$(wk 2 1)|$(wk 2 0)" "$(su -c "select session_date||'|'||week_start from public.subscription_registration_coverage where registration_id='$R1'")"
expect "one covered in the new week" "1" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB' and week_start='$(wk 2 0)' and covered")"
su -c "update public.training_sessions set max_participants=2 where id='$S1'" >/dev/null
expect "row follows the tier" "pair" "$(su -c "select tier from public.subscription_registration_coverage where registration_id='$R1'")"

finish
